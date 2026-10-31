import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EXPECTED_SCENARIO_COUNT,
  SCENARIO_CATALOG_FILENAME,
  SCENARIO_CATALOG_VERSION,
  SITUATIONS_CATALOG_VERSION,
  SITUATIONS_FILENAME,
  getScenario,
  getSituation,
  listCompatibleScenarios,
  listCompatibleSituations,
  loadScenarioCatalog,
  loadSituations,
  loadValidatedCatalogs,
  readScenarioReferenceBytes,
  resolveFunctionsRoot,
  resolveScenarioReference,
  selectScenarioSituation,
  validateScenarioCatalog,
  validateSituations,
} from "../src/scenario_catalog";

const FUNCTIONS_ROOT = process.cwd();

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(FUNCTIONS_ROOT, relativePath), "utf8")) as T;
}

test("catalog loads 16 versioned records plus separately versioned action events", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  assert.equal(catalog.version, SCENARIO_CATALOG_VERSION);
  assert.equal(catalog.version, "v1");
  assert.equal(situations.version, SITUATIONS_CATALOG_VERSION);
  assert.equal(catalog.records.length, EXPECTED_SCENARIO_COUNT);
  assert.ok(situations.events.length > 0);
  // Every record carries the full required surface.
  for (const record of catalog.records) {
    assert.equal(record.version, 1);
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    assert.ok(record.sizeBytes > 0);
    assert.equal(record.referencePath, `assets/scenario_refs/${record.sourceFilename}`);
    for (const field of ["scene", "layout", "palette", "linework", "textures", "light", "era"] as const) {
      assert.ok(record.observed[field].length > 0, `${record.id} observed.${field}`);
    }
    for (const field of ["observedNote", "identification", "confidence", "confidenceNote", "stylePrompt", "scenarioPrompt", "situationConstraints"] as const) {
      assert.ok(record[field].length > 0, `${record.id} ${field}`);
    }
    assert.ok(record.compatibleSituations.length > 0);
  }
  // Situations are timed action choreographies, never bare style names.
  for (const event of situations.events) {
    assert.equal(event.version, 1);
    assert.ok(event.action.length >= 40, `${event.id} action`);
    assert.ok(/0-1s|1-2s|2s/.test(event.action), `${event.id} action carries timed beats`);
  }
});

test("every record hashes to its actual packaged bytes (no digest drift)", () => {
  const { catalog } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const seen = new Set<string>();
  for (const record of catalog.records) {
    const bytes = readScenarioReferenceBytes(record, FUNCTIONS_ROOT);
    assert.equal(bytes.byteLength, record.sizeBytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256);
    // Reference resolves under the functions root with a portable path.
    const resolved = resolveScenarioReference(record, FUNCTIONS_ROOT);
    assert.ok(resolved.startsWith(FUNCTIONS_ROOT));
    assert.ok(!resolved.includes(".."));
    seen.add(record.sourceFilename);
  }
  assert.equal(seen.size, EXPECTED_SCENARIO_COUNT);
});

test("altered digests, sizes, and missing references are rejected", () => {
  const { catalog } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const record = catalog.records[0];
  assert.throws(() => readScenarioReferenceBytes({ ...record, sha256: "0".repeat(64) }, FUNCTIONS_ROOT), /digest mismatch/);
  assert.throws(() => readScenarioReferenceBytes({ ...record, sizeBytes: record.sizeBytes + 1 }, FUNCTIONS_ROOT), /size mismatch/);
  // Empty checkout stand-in: catalogs present, reference bytes absent.
  const scratch = mkdtempSync(join(tmpdir(), "scenario-missing-"));
  try {
    writeFileSync(join(scratch, "package.json"), '{"name":"scratch-functions"}');
    cpSync(join(FUNCTIONS_ROOT, "assets", SCENARIO_CATALOG_FILENAME), join(scratch, "assets", SCENARIO_CATALOG_FILENAME));
    cpSync(join(FUNCTIONS_ROOT, "assets", SITUATIONS_FILENAME), join(scratch, "assets", SITUATIONS_FILENAME));
    const { catalog: lonely } = loadValidatedCatalogs(scratch);
    assert.throws(() => readScenarioReferenceBytes(lonely.records[0], scratch), /missing/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.throws(() => loadValidatedCatalogs(mkdtempSync(join(tmpdir(), "scenario-empty-"))), /functions root|missing/);
});

test("duplicate ids, unsafe paths, and bad digests fail structural validation", () => {
  const catalog = readJson<{ records: Array<Record<string, unknown>> }>(`assets/${SCENARIO_CATALOG_FILENAME}`);
  const dup = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  dup.records[1] = { ...dup.records[0] };
  assert.throws(() => validateScenarioCatalog(dup), /Duplicate scenario id/);
  const dupFile = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  dupFile.records[1] = { ...(dupFile.records[0] as Record<string, unknown>), id: "renamed-but-same-file" };
  assert.throws(() => validateScenarioCatalog(dupFile), /Duplicate scenario source file/);
  const unsafe = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  (unsafe.records[2] as Record<string, unknown>).referencePath = "../outside/evil.JPG";
  assert.throws(() => validateScenarioCatalog(unsafe), /repo-relative|escapes/);
  const absolute = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  (absolute.records[2] as Record<string, unknown>).referencePath = "/tmp/evil.JPG";
  assert.throws(() => validateScenarioCatalog(absolute), /repo-relative/);
  const badDigest = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  (badDigest.records[3] as Record<string, unknown>).sha256 = "not-a-digest";
  assert.throws(() => validateScenarioCatalog(badDigest), /sha256/);
  const dropped = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
  dropped.records.pop();
  assert.throws(() => validateScenarioCatalog(dropped), /exactly 16/);
});

test("compatible selection works and incompatible pairs are rejected", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const first = catalog.records[0];
  const compatibleId = first.compatibleSituations[0];
  const picked = selectScenarioSituation(catalog, situations, first.id, compatibleId);
  assert.equal(picked.scenario.stylePrompt, first.stylePrompt);
  assert.equal(picked.situation.id, compatibleId);
  assert.deepEqual(
    listCompatibleSituations(catalog, situations, first.id).map((event) => event.id),
    first.compatibleSituations,
  );
  const other = situations.events.find((event) => !first.compatibleSituations.includes(event.id));
  assert.ok(other, "catalog has at least one incompatible pair to gate");
  assert.throws(
    () => selectScenarioSituation(catalog, situations, first.id, other!.id),
    /Incompatible pair/,
  );
  assert.throws(() => getScenario(catalog, "no-such-scenario"), /Unknown scenario/);
  assert.throws(() => getSituation(situations, "no-such-situation"), /Unknown situation/);
  assert.deepEqual(
    listCompatibleScenarios(catalog, situations, compatibleId).map((record) => record.id).sort(),
    catalog.records.filter((record) => record.compatibleSituations.includes(compatibleId)).map((record) => record.id).sort(),
  );
});

test("review batch samples resolve to compatible catalog pairs", () => {
  const { catalog, situations } = loadValidatedCatalogs(FUNCTIONS_ROOT);
  const reviewBatch = readJson<{ reviewBatch: { samples: Array<{ scenarioId: string; situationId: string }> } }>(
    `assets/${SCENARIO_CATALOG_FILENAME}`,
  ).reviewBatch;
  assert.ok(Array.isArray(reviewBatch.samples) && reviewBatch.samples.length > 0);
  for (const sample of reviewBatch.samples) {
    const picked = selectScenarioSituation(catalog, situations, sample.scenarioId, sample.situationId);
    assert.ok(picked.scenario.scenarioPrompt.length > 0);
    assert.ok(picked.situation.action.length > 0);
  }
});

test("relocated artifact loads every entry and reference without the repo checkout", () => {
  const scratch = mkdtempSync(join(tmpdir(), "scenario-relocated-"));
  writeFileSync(join(scratch, "package.json"), '{"name":"relocated-functions"}');
  // Packaged layout only: runtime/scenarios/**, no assets/ tree.
  cpSync(join(FUNCTIONS_ROOT, "assets", SCENARIO_CATALOG_FILENAME), join(scratch, "runtime", "scenarios", SCENARIO_CATALOG_FILENAME), { recursive: true });
  cpSync(join(FUNCTIONS_ROOT, "assets", SITUATIONS_FILENAME), join(scratch, "runtime", "scenarios", SITUATIONS_FILENAME), { recursive: true });
  cpSync(join(FUNCTIONS_ROOT, "assets", "scenario_refs"), join(scratch, "runtime", "scenarios", "scenario_refs"), { recursive: true });
  assert.equal(resolveFunctionsRoot(join(scratch, "runtime", "scenarios")), scratch);
  const { catalog, situations } = loadValidatedCatalogs(scratch);
  assert.equal(catalog.records.length, EXPECTED_SCENARIO_COUNT);
  for (const record of catalog.records) {
    const resolved = resolveScenarioReference(record, scratch);
    assert.ok(resolved.startsWith(join(scratch, "runtime", "scenarios")), `${record.id} resolves to the packaged copy`);
    assert.ok(!existsSync(join(scratch, "assets", record.sourceFilename)), "no checkout fallback on disk");
    const bytes = readScenarioReferenceBytes(record, scratch);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256);
  }
  assert.ok(loadSituations(scratch).events.length > 0);
  void validateSituations;
});
