/**
 * Backend-owned cartoon scenario catalog: 16 versioned image-backed scenario
 * records plus separately versioned comic-spooky action events (situations).
 *
 * Pipeline role (p2 consumes this; p1 only catalogs): a cartoon still is
 * generated from separately identified portrait and scene/style references,
 * then that generated still is animated. Scenarios name the STYLE/place;
 * situations name the MOTION (timed action beats, never just a style name).
 * This module is the validated lookup + compatible-situation API for p2.
 *
 * Loading is relocation-safe: the packaged runtime copy
 * (`runtime/scenarios/…`, placed by tools/prepare_runtime.ts) is preferred and
 * the repository checkout copy (`assets/…`) is the fallback. No path here
 * assumes the repository root, a user home directory, or a symlink: every
 * reference resolves under an explicit functions root with portable
 * repo-relative paths only.
 *
 * Zero provider spend: pure local file reads + SHA-256. No network, no
 * secrets, no signed URLs (reference bytes are packaged, not fetched).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { BackendError } from "./contracts";

/** Versioned catalog filenames. Bumped only by explicit owner review. */
export const SCENARIO_CATALOG_VERSION = "v1" as const;
export const SITUATIONS_CATALOG_VERSION = "v1" as const;
export const SCENARIO_CATALOG_FILENAME = `scenario_catalog.${SCENARIO_CATALOG_VERSION}.json` as const;
export const SITUATIONS_FILENAME = `situations.${SITUATIONS_CATALOG_VERSION}.json` as const;

/** Exactly 16 image-backed scenarios; one record per allowlisted file. */
export const EXPECTED_SCENARIO_COUNT = 16 as const;

/** Allowlisted reference filenames (exact bytes live under assets/scenario_refs/). */
export const SCENARIO_REF_FILENAMES = [
  "2938c25f-4772-415d-bab0-941b2521be3d.JPG",
  "3f2db6e1-7b6b-4bb9-992d-a1f3584fbad0.JPG",
  "52398ea0-a1f8-4639-aa74-1671ce6c276b.JPG",
  "5c0e9bf8-864a-4146-b2f7-4e04f5c2520e.JPG",
  "78b5c629-0ce2-4944-9ce1-7eb9b8570ddf.JPG",
  "7a712bff-0095-4610-9741-f9a380bce068.JPG",
  "96cf7a63-7d8e-485e-a7cc-9e6654b920e6.JPG",
  "98a6182f-1de7-46a4-8013-f7e501e85d21.JPG",
  "9b8b9749-da46-4782-b34f-72137f9f5f00.JPG",
  "IMG_3924.JPG",
  "a840217b-d807-4e2f-9476-370443e83bbc.JPG",
  "bd75cef5-bd11-4fb9-8ac7-89498a765f93.JPG",
  "cb10e539-fec1-4416-8717-50a427e46dda.JPG",
  "d317360a-7db0-4a19-a778-c1e35c46aa18.JPG",
  "f92785a5-c171-40e8-846d-76ba366446f1.JPG",
  "ff03626f-fe41-40b0-9d12-92ba6a9aaa5a.JPG",
] as const;

export type ScenarioRefFilename = (typeof SCENARIO_REF_FILENAMES)[number];

/** Portable repo-relative locations (never absolute, never ~, never /tmp). */
export const SCENARIO_REF_DIR = "assets/scenario_refs" as const;
export const PACKAGED_SCENARIO_DIR = "runtime/scenarios" as const;
export const PACKAGED_SCENARIO_REF_DIR = "runtime/scenarios/scenario_refs" as const;

const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ScenarioObserved {
  scene: string;
  layout: string;
  palette: string;
  linework: string;
  textures: string;
  light: string;
  era: string;
}

export interface ScenarioRecord {
  id: string;
  version: number;
  sourceFilename: string;
  referencePath: string;
  sha256: string;
  sizeBytes: number;
  observedNote: string;
  observed: ScenarioObserved;
  identification: string;
  confidence: string;
  confidenceNote: string;
  stylePrompt: string;
  scenarioPrompt: string;
  situationConstraints: string;
  compatibleSituations: string[];
}

export interface ScenarioCatalogFile {
  catalog: string;
  version: string;
  formatVersion: number;
  provenance?: Record<string, unknown>;
  records: ScenarioRecord[];
  reviewBatch?: {
    samples?: Array<{ scenarioId?: string; situationId?: string; note?: string }>;
    [key: string]: unknown;
  };
  budgetGate?: Record<string, unknown>;
}

export interface SituationEvent {
  id: string;
  version: number;
  name: string;
  /** Timed action choreography. An action such as a chase is never just a style name. */
  action: string;
  constraints: string;
  compatibleScenarios: string[];
}

export interface SituationsFile {
  catalog: string;
  version: string;
  formatVersion: number;
  provenance?: Record<string, unknown>;
  events: SituationEvent[];
}

function fail(code: "INVALID_ARGUMENT" | "NOT_FOUND", message: string): never {
  throw new BackendError(code, message);
}

/** Rejects absolute paths, home shortcuts, drive letters, and escapes. */
export function assertSafeRepoRelativePath(path: string, label: string): void {
  if (typeof path !== "string" || !path) fail("INVALID_ARGUMENT", `${label} must be a non-empty repo-relative path.`);
  if (isAbsolute(path) || path.startsWith("~") || /^[A-Za-z]:/.test(path) || path.includes("\\")) {
    fail("INVALID_ARGUMENT", `${label} must be a portable repo-relative path (found ${JSON.stringify(path)}).`);
  }
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.startsWith("../") || isAbsolute(normalized)) {
    fail("INVALID_ARGUMENT", `${label} escapes the functions root (found ${JSON.stringify(path)}).`);
  }
  if (/(^|\/)\.(($|\/)|\.($|\/))/.test(normalized.replace(/\\/g, "/"))) {
    fail("INVALID_ARGUMENT", `${label} contains a dot segment (found ${JSON.stringify(path)}).`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    fail("INVALID_ARGUMENT", `${label} requires a non-empty ${field}.`);
  }
  return (value as string).trim();
}

/** Structural record validation: no filesystem access. */
export function validateScenarioRecord(value: unknown): asserts value is ScenarioRecord {
  if (!isRecord(value)) fail("INVALID_ARGUMENT", "Scenario record must be an object.");
  const record = value as Record<string, unknown>;
  const id = requiredString(record, "id", "Scenario record");
  if (!ID_RE.test(id)) fail("INVALID_ARGUMENT", `Scenario id is invalid: ${JSON.stringify(id)}.`);
  if (record.version !== 1) fail("INVALID_ARGUMENT", `Scenario ${id} must be version 1.`);
  const sourceFilename = requiredString(record, "sourceFilename", `Scenario ${id}`);
  if (!(SCENARIO_REF_FILENAMES as readonly string[]).includes(sourceFilename)) {
    fail("INVALID_ARGUMENT", `Scenario ${id} references a non-allowlisted file: ${sourceFilename}.`);
  }
  const referencePath = requiredString(record, "referencePath", `Scenario ${id}`);
  assertSafeRepoRelativePath(referencePath, `Scenario ${id} referencePath`);
  if (referencePath !== `${SCENARIO_REF_DIR}/${sourceFilename}`) {
    fail("INVALID_ARGUMENT", `Scenario ${id} referencePath must be ${SCENARIO_REF_DIR}/${sourceFilename}.`);
  }
  const sha256 = requiredString(record, "sha256", `Scenario ${id}`);
  if (!HASH_RE.test(sha256)) fail("INVALID_ARGUMENT", `Scenario ${id} has an invalid sha256 digest.`);
  if (!Number.isSafeInteger(record.sizeBytes) || (record.sizeBytes as number) <= 0) {
    fail("INVALID_ARGUMENT", `Scenario ${id} has an invalid sizeBytes.`);
  }
  for (const field of ["observedNote", "identification", "confidence", "confidenceNote", "stylePrompt", "scenarioPrompt", "situationConstraints"] as const) {
    requiredString(record, field, `Scenario ${id}`);
  }
  if (!isRecord(record.observed)) fail("INVALID_ARGUMENT", `Scenario ${id} requires an observed scene breakdown.`);
  for (const field of ["scene", "layout", "palette", "linework", "textures", "light", "era"] as const) {
    requiredString(record.observed as Record<string, unknown>, field, `Scenario ${id} observed`);
  }
  if (!Array.isArray(record.compatibleSituations) || record.compatibleSituations.length === 0 ||
      record.compatibleSituations.some((entry) => typeof entry !== "string" || !ID_RE.test(entry))) {
    fail("INVALID_ARGUMENT", `Scenario ${id} requires a non-empty compatibleSituations list of event ids.`);
  }
}

/** Structural catalog validation: counts, versions, duplicate ids/files. */
export function validateScenarioCatalog(value: unknown): asserts value is ScenarioCatalogFile {
  if (!isRecord(value)) fail("INVALID_ARGUMENT", "Scenario catalog must be an object.");
  const catalog = value as Record<string, unknown>;
  if (catalog.catalog !== "scenario_catalog") fail("INVALID_ARGUMENT", "Scenario catalog kind must be scenario_catalog.");
  if (catalog.version !== SCENARIO_CATALOG_VERSION) {
    fail("INVALID_ARGUMENT", `Scenario catalog version must be ${SCENARIO_CATALOG_VERSION}.`);
  }
  if (!Array.isArray(catalog.records)) fail("INVALID_ARGUMENT", "Scenario catalog requires a records array.");
  const records = catalog.records as unknown[];
  if (records.length !== EXPECTED_SCENARIO_COUNT) {
    fail("INVALID_ARGUMENT", `Scenario catalog must hold exactly ${EXPECTED_SCENARIO_COUNT} records (found ${records.length}).`);
  }
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const record of records) {
    validateScenarioRecord(record);
    const typed = record as ScenarioRecord;
    if (ids.has(typed.id)) fail("INVALID_ARGUMENT", `Duplicate scenario id: ${typed.id}.`);
    if (files.has(typed.sourceFilename)) fail("INVALID_ARGUMENT", `Duplicate scenario source file: ${typed.sourceFilename}.`);
    ids.add(typed.id);
    files.add(typed.sourceFilename);
  }
  const missing = (SCENARIO_REF_FILENAMES as readonly string[]).filter((name) => !files.has(name));
  if (missing.length) fail("INVALID_ARGUMENT", `Scenario catalog is missing allowlisted files: ${missing.join(", ")}.`);
}

/** Structural situations validation: versions, duplicate ids, action beats. */
export function validateSituations(value: unknown): asserts value is SituationsFile {
  if (!isRecord(value)) fail("INVALID_ARGUMENT", "Situations catalog must be an object.");
  const catalog = value as Record<string, unknown>;
  if (catalog.catalog !== "situations") fail("INVALID_ARGUMENT", "Situations catalog kind must be situations.");
  if (catalog.version !== SITUATIONS_CATALOG_VERSION) {
    fail("INVALID_ARGUMENT", `Situations version must be ${SITUATIONS_CATALOG_VERSION}.`);
  }
  if (!Array.isArray(catalog.events) || catalog.events.length === 0) {
    fail("INVALID_ARGUMENT", "Situations catalog requires a non-empty events array.");
  }
  const ids = new Set<string>();
  for (const event of catalog.events as unknown[]) {
    if (!isRecord(event)) fail("INVALID_ARGUMENT", "Situation event must be an object.");
    const entry = event as Record<string, unknown>;
    const id = requiredString(entry, "id", "Situation event");
    if (!ID_RE.test(id)) fail("INVALID_ARGUMENT", `Situation id is invalid: ${JSON.stringify(id)}.`);
    if (ids.has(id)) fail("INVALID_ARGUMENT", `Duplicate situation id: ${id}.`);
    ids.add(id);
    if (entry.version !== 1) fail("INVALID_ARGUMENT", `Situation ${id} must be version 1.`);
    const action = requiredString(entry, "action", `Situation ${id}`);
    if (action.length < 40) {
      fail("INVALID_ARGUMENT", `Situation ${id} action must be a timed choreography, not a style name.`);
    }
    for (const field of ["name", "constraints"] as const) requiredString(entry, field, `Situation ${id}`);
    if (!Array.isArray(entry.compatibleScenarios) || entry.compatibleScenarios.length === 0 ||
        entry.compatibleScenarios.some((name) => typeof name !== "string" || !ID_RE.test(name))) {
      fail("INVALID_ARGUMENT", `Situation ${id} requires a non-empty compatibleScenarios list of scenario ids.`);
    }
  }
}

/**
 * Cross-catalog compatibility: every scenario link resolves to a known event,
 * every event link resolves to a known scenario, and links are symmetric so
 * p2 can never select an incompatible scenario/situation pair silently.
 */
export function validateCatalogCompatibility(catalog: ScenarioCatalogFile, situations: SituationsFile): void {
  const scenarioIds = new Set(catalog.records.map((record) => record.id));
  const eventById = new Map(situations.events.map((event) => [event.id, event]));
  for (const record of catalog.records) {
    for (const situationId of record.compatibleSituations) {
      const event = eventById.get(situationId);
      if (!event) fail("INVALID_ARGUMENT", `Scenario ${record.id} links unknown situation ${situationId}.`);
      if (!event.compatibleScenarios.includes(record.id)) {
        fail("INVALID_ARGUMENT", `Scenario ${record.id} links ${situationId} without a symmetric event link.`);
      }
    }
  }
  for (const event of situations.events) {
    for (const scenarioId of event.compatibleScenarios) {
      if (!scenarioIds.has(scenarioId)) fail("INVALID_ARGUMENT", `Situation ${event.id} links unknown scenario ${scenarioId}.`);
      const record = catalog.records.find((entry) => entry.id === scenarioId)!;
      if (!record.compatibleSituations.includes(event.id)) {
        fail("INVALID_ARGUMENT", `Situation ${event.id} links ${scenarioId} without a symmetric scenario link.`);
      }
    }
  }
}

/**
 * Resolves the functions root from a module directory without assuming the
 * repository root: walks up until a directory holding package.json is found.
 * Never consults /tmp, $HOME, or symlinks outside the walk.
 */
export function resolveFunctionsRoot(fromDirectory = __dirname): string {
  let current = resolve(fromDirectory);
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, "package.json")) &&
        (existsSync(join(current, "assets", SCENARIO_CATALOG_FILENAME)) ||
         existsSync(join(current, PACKAGED_SCENARIO_DIR, SCENARIO_CATALOG_FILENAME)))) {
      return current;
    }
    const parent = resolve(join(current, ".."));
    if (parent === current) break;
    current = parent;
  }
  fail("NOT_FOUND", "Cannot locate the functions root (no package.json with a scenario catalog nearby).");
}

/** Packaged runtime copy first (relocated artifact), repo checkout fallback. */
export function catalogFileCandidates(functionsRoot: string, filename: string): string[] {
  return [join(functionsRoot, PACKAGED_SCENARIO_DIR, filename), join(functionsRoot, "assets", filename)];
}

function readCatalogJson<T>(functionsRoot: string, filename: string, label: string): T {
  const tried: string[] = [];
  for (const candidate of catalogFileCandidates(functionsRoot, filename)) {
    tried.push(candidate);
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, "utf8")) as T;
      } catch {
        fail("INVALID_ARGUMENT", `${label} at ${candidate} is not valid JSON.`);
      }
    }
  }
  fail("NOT_FOUND", `${label} is missing (tried ${tried.join("; ")}); run npm run runtime:prepare.`);
}

/** Loads + structurally validates the scenario catalog for a functions root. */
export function loadScenarioCatalog(functionsRoot: string): ScenarioCatalogFile {
  const catalog = readCatalogJson<unknown>(functionsRoot, SCENARIO_CATALOG_FILENAME, "Scenario catalog");
  validateScenarioCatalog(catalog);
  return catalog as ScenarioCatalogFile;
}

/** Loads + structurally validates the situations catalog for a functions root. */
export function loadSituations(functionsRoot: string): SituationsFile {
  const situations = readCatalogJson<unknown>(functionsRoot, SITUATIONS_FILENAME, "Situations catalog");
  validateSituations(situations);
  return situations as SituationsFile;
}

/** Loads both catalogs and enforces cross-catalog compatibility. */
export function loadValidatedCatalogs(functionsRoot: string): { catalog: ScenarioCatalogFile; situations: SituationsFile } {
  const catalog = loadScenarioCatalog(functionsRoot);
  const situations = loadSituations(functionsRoot);
  validateCatalogCompatibility(catalog, situations);
  return { catalog, situations };
}

/**
 * Resolves a scenario's reference bytes: packaged runtime copy first so a
 * relocated Functions artifact never needs the repository checkout.
 */
export function resolveScenarioReference(record: ScenarioRecord, functionsRoot: string): string {
  assertSafeRepoRelativePath(record.referencePath, `Scenario ${record.id} referencePath`);
  const filename = record.referencePath.split("/").pop() ?? "";
  if (!(SCENARIO_REF_FILENAMES as readonly string[]).includes(filename)) {
    fail("INVALID_ARGUMENT", `Scenario ${record.id} references a non-allowlisted file: ${filename}.`);
  }
  const packaged = join(functionsRoot, PACKAGED_SCENARIO_REF_DIR, filename);
  if (existsSync(packaged)) return packaged;
  const checkout = resolve(functionsRoot, record.referencePath);
  if (!checkout.startsWith(resolve(functionsRoot) + sep)) {
    fail("INVALID_ARGUMENT", `Scenario ${record.id} reference escapes the functions root.`);
  }
  return checkout;
}

/** Reads + hashes the actual packaged bytes; rejects missing/altered files. */
export function readScenarioReferenceBytes(record: ScenarioRecord, functionsRoot: string): Buffer {
  const path = resolveScenarioReference(record, functionsRoot);
  if (!existsSync(path)) fail("NOT_FOUND", `Scenario ${record.id} reference is missing: ${record.referencePath}.`);
  const bytes = readFileSync(path);
  if (bytes.byteLength !== record.sizeBytes) {
    fail("INVALID_ARGUMENT", `Scenario ${record.id} size mismatch (file ${bytes.byteLength} vs catalog ${record.sizeBytes}).`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== record.sha256) {
    fail("INVALID_ARGUMENT", `Scenario ${record.id} digest mismatch (file ${digest.slice(0, 12)}… vs catalog ${record.sha256.slice(0, 12)}…).`);
  }
  return bytes;
}

/** Validated lookup: unknown ids are NOT_FOUND, never undefined. */
export function getScenario(catalog: ScenarioCatalogFile, scenarioId: string): ScenarioRecord {
  const record = catalog.records.find((entry) => entry.id === scenarioId);
  if (!record) fail("NOT_FOUND", `Unknown scenario: ${scenarioId}.`);
  return record;
}

/** Validated lookup: unknown ids are NOT_FOUND, never undefined. */
export function getSituation(situations: SituationsFile, situationId: string): SituationEvent {
  const event = situations.events.find((entry) => entry.id === situationId);
  if (!event) fail("NOT_FOUND", `Unknown situation: ${situationId}.`);
  return event;
}

export function listScenarios(catalog: ScenarioCatalogFile): ScenarioRecord[] {
  return [...catalog.records];
}

export function listSituations(situations: SituationsFile): SituationEvent[] {
  return [...situations.events];
}

/** Compatible-situation API for p2: situations this scenario may pair with. */
export function listCompatibleSituations(catalog: ScenarioCatalogFile, situations: SituationsFile, scenarioId: string): SituationEvent[] {
  const record = getScenario(catalog, scenarioId);
  return record.compatibleSituations.map((id) => getSituation(situations, id));
}

/** Compatible-scenario API for p2: scenarios this situation may pair with. */
export function listCompatibleScenarios(catalog: ScenarioCatalogFile, situations: SituationsFile, situationId: string): ScenarioRecord[] {
  const event = getSituation(situations, situationId);
  return event.compatibleScenarios.map((id) => getScenario(catalog, id));
}

/**
 * Pair selection gate for p2: rejects incompatible scenario/situation pairs
 * (and unknown ids) before any still/video prompt is composed.
 */
export function selectScenarioSituation(
  catalog: ScenarioCatalogFile,
  situations: SituationsFile,
  scenarioId: string,
  situationId: string,
): { scenario: ScenarioRecord; situation: SituationEvent } {
  const scenario = getScenario(catalog, scenarioId);
  const situation = getSituation(situations, situationId);
  if (!scenario.compatibleSituations.includes(situationId) || !situation.compatibleScenarios.includes(scenarioId)) {
    fail("INVALID_ARGUMENT", `Incompatible pair: scenario ${scenarioId} does not support situation ${situationId}.`);
  }
  return { scenario, situation };
}
