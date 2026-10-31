import { Bucket } from "@google-cloud/storage";
import { FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";
import { assertRegisteredPartyDevice } from "./auth";
import { BackendError, isSupportedConsent, parseRequestGeneration, RequestGenerationInput, requireIdentity, validateId } from "./contracts";
import { CAMEO_DEMO_PRESET, CHEAP_DEMO_PRESET, MEDIA_RETENTION_MS, REQUIRED_CAMERA_IDS } from "./config";
import { assertGuestEligible, GuestMediaDoc } from "./guest_media";
import { cartoonStillIntentDocument, cartoonStillLedgerPath, usageIntentDocument, usageLedgerPath } from "./usage";
import { CameraId, CartoonPlan, ProviderResult, ProviderTaskStatus, validateCartoonPlan, validatePresetControls } from "./video_generation_port";
import { buildAutoCartoonPlan } from "./cartoon_pipeline";
import { loadValidatedCatalogs, resolveFunctionsRoot } from "./scenario_catalog";

export interface GenerationTask {
  partyId: string;
  deviceId: string;
  channelId: string;
  jobId: string;
  idempotencyKey: string;
}

export interface GenerationStoreOptions {
  db: Firestore;
  bucket: Bucket;
  now?: () => Date;
}

export interface SeedProvenanceBinding {
  seedId: string;
  kind: string;
}

export interface CreateJobOptions {
  /** Server-written seed binding (host path only; callers must never supply it). */
  seedProvenance?: SeedProvenanceBinding;
}

export interface RequestGenerationResult {
  jobId: string;
  partyId: string;
  deviceId: string;
  channelId: string;
  state: string;
  created: boolean;
  manifestVersion: number;
  timestamp: unknown;
  idempotencyKey: string;
}

function jobRef(db: Firestore, partyId: string, jobId: string) {
  return db.doc(`parties/${partyId}/jobs/${jobId}`);
}

function currentManifestRef(db: Firestore, partyId: string, channelId: string) {
  return db.doc(`parties/${partyId}/manifests/current_${channelId}`);
}

function budgetRef(db: Firestore, partyId: string) {
  return db.doc(`parties/${partyId}/generationBudget/active`);
}

function deliveryObjectPath(partyId: string, channelId: string, version: number, cameraId: CameraId): string {
  return `parties/${partyId}/channels/${channelId}/delivery/${version}/${cameraId}.mp4`;
}

/**
 * Persistence guard: signed reference URLs are in-flight only and must never
 * reach Firestore job docs. The guest binding stores server-side state
 * (objectPath + sourceHash + consentRevision) exclusively.
 */
function assertNoSignedReferenceUrl(value: unknown): void {
  const serialized = JSON.stringify(value ?? null);
  if (/https?:\/\//.test(serialized) && /signed/.test(serialized)) {
    throw new BackendError("INTERNAL", "Signed reference URLs must never be persisted.");
  }
}

function exposedTimestamp(value: unknown): unknown {
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    return ((value as { toDate: () => Date }).toDate()).toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Fake-only rehearsal marker. The operator rehearsal tool always sends
 * `rehearsalOnly: true`; the marker is persisted on the job document and the
 * worker resolves ONLY the offline fake provider for marked jobs, regardless
 * of the deployed provider configuration. Requests without the marker take
 * the unchanged default path. Any other marker value is rejected fail-closed
 * so the flag can never be weakened into a live-looking request.
 */
function extractRehearsalOnly(value: unknown): boolean {
  if (value && typeof value === "object" && !Array.isArray(value) && "rehearsalOnly" in value) {
    if ((value as Record<string, unknown>).rehearsalOnly !== true) {
      throw new BackendError("INVALID_ARGUMENT", "rehearsalOnly must be true when present.");
    }
    return true;
  }
  return false;
}

/**
 * Strips the rehearsal marker before shared cheap_demo control validation and
 * request parsing, which only accept the fixed preset fields. The marker is
 * handled (validated, bound, persisted) by the store itself.
 */
function stripRehearsalOnly(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "rehearsalOnly" in value) {
    const { rehearsalOnly: _ignored, ...rest } = value as Record<string, unknown>;
    return rest;
  }
  return value;
}

/**
 * Strips a caller-supplied cartoon plan before shared control validation and
 * request parsing (defense in depth: requestGeneration already rejects caller
 * plans; only requestCartoonFromPortrait builds the server plan).
 */
function stripCartoonPlan(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "cartoonPlan" in value) {
    const { cartoonPlan: _ignored, ...rest } = value as Record<string, unknown>;
    return rest;
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function cartoonPlansEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a ?? null)) === JSON.stringify(canonicalize(b ?? null));
}

export class FirestoreGenerationStore {
  readonly db: Firestore;
  readonly bucket: Bucket;
  private readonly now: () => Date;

  constructor(options: GenerationStoreOptions) {
    this.db = options.db;
    this.bucket = options.bucket;
    this.now = options.now ?? (() => new Date());
  }

  async requestGeneration(value: unknown, opts?: CreateJobOptions): Promise<RequestGenerationResult> {
    // Cartoon plans are server-assigned at job setup (auto-select from the
    // seeded RNG); callers must never supply a plan, prompt, scene, or
    // situation. The portrait auto-enqueue path (requestCartoonFromPortrait)
    // is the only writer of cartoon plans.
    if (value && typeof value === "object" && !Array.isArray(value) && "cartoonPlan" in value) {
      throw new BackendError("INVALID_ARGUMENT", "Cartoon plans are assigned by the server; supply only the portrait submission.");
    }
    // Seed provenance is server-written (host path via opts only); callers
    // must never supply it.
    if (value && typeof value === "object" && !Array.isArray(value) && "seedProvenance" in value) {
      throw new BackendError("INVALID_ARGUMENT", "Seed provenance is assigned by the server.");
    }
    if (opts?.seedProvenance !== undefined) {
      if (typeof opts.seedProvenance.seedId !== "string" || !opts.seedProvenance.seedId ||
          opts.seedProvenance.kind !== "host") {
        throw new BackendError("INVALID_ARGUMENT", "Seed provenance binding is invalid.");
      }
      validateId(opts.seedProvenance.seedId, "seedId");
    }
    return this.createJob(value, undefined, opts);
  }

  /**
   * Shared server-side cartoon plan selection (fix-5a): the catalog
   * scenario + compatible situation are selected deterministically from the
   * stable submission id, so every caller (guest auto-enqueue, explicit
   * portrait request, host seed request) derives the SAME immutable plan
   * for the same portrait. Single helper, never duplicated.
   */
  private buildSharedCartoonPlan(guestMediaId: string): Record<string, unknown> {
    const functionsRoot = resolveFunctionsRoot();
    const { catalog, situations } = loadValidatedCatalogs(functionsRoot);
    return buildAutoCartoonPlan({ submissionId: guestMediaId, catalog, situations }) as unknown as Record<string, unknown>;
  }

  /**
   * Minimal portrait request (cycle-13 fix-3): identity + guestMediaId only.
   * The server randomly selects the catalog scenario + compatible situation
   * (seeded RNG keyed by the submission id), persists the plan immutably at
   * creation, and enqueues exactly one two-stage cartoon job. Retries and
   * ingest-finalization replays reuse the persisted plan and never reroll or
   * rebill: the job id and idempotency key derive deterministically from the
   * submission id, so a second call returns the existing job (created:false).
   * Any caller-supplied plan/prompt/scene/situation field is rejected — the
   * client must not supply a plan.
   */
  async requestCartoonFromPortrait(value: unknown): Promise<RequestGenerationResult & { scenarioId: string; situationId: string }> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BackendError("INVALID_ARGUMENT", "Portrait request must be an object.");
    }
    const record = value as Record<string, unknown>;
    for (const forbidden of ["cartoonPlan", "prompt", "scenarioId", "situationId", "presetId", "modelId", "stillPlanId", "videoPlanId", "seed"]) {
      if (forbidden in record) {
        throw new BackendError("INVALID_ARGUMENT", "Cartoon plans are assigned by the server; supply only the portrait submission.");
      }
    }
    const identity = requireIdentity(value);
    if (!identity.channelId) throw new BackendError("INVALID_ARGUMENT", "channelId is required.");
    if (typeof record.guestMediaId !== "string" || !record.guestMediaId) {
      throw new BackendError("INVALID_ARGUMENT", "guestMediaId is required.");
    }
    const guestMediaId = validateId(record.guestMediaId, "guestMediaId");
    // Consent/budget entry gate: the portrait must be eligible right now; the
    // creation transaction, worker submit, and publication recheck, so a
    // withdrawal races fail closed.
    await assertGuestEligible(this.db, identity, guestMediaId, this.now().getTime());
    const rehearsalOnly = extractRehearsalOnly(value);
    // Server-side auto-select via the shared helper: retries reuse the same
    // pair (same submission id -> same plan, never rerolled).
    const cartoonPlan = this.buildSharedCartoonPlan(guestMediaId);
    const jobId = `cartoon-${guestMediaId}`;
    const idempotencyKey = `cartoon-${guestMediaId}`;
    const created = await this.createJob({
      partyId: identity.partyId,
      deviceId: identity.deviceId,
      channelId: identity.channelId,
      jobId,
      idempotencyKey,
      presetId: CHEAP_DEMO_PRESET.presetId,
      guestMediaId,
      ...(rehearsalOnly ? { rehearsalOnly: true as const } : {}),
    }, cartoonPlan as unknown as Record<string, unknown>);
    const plan = cartoonPlan as unknown as { scenarioId: string; situationId: string };
    return { ...created, scenarioId: plan.scenarioId, situationId: plan.situationId };
  }

  /**
   * Host seed cartoon request (fix-5a): the same shared server selection as
   * requestCartoonFromPortrait (same plan for the same portrait), persisted
   * on the host job `hv-{seedId}` with the server-written host seed binding.
   * Shares ONE plan with the guest auto path per portrait; single-flight and
   * idempotency reuse semantics are identical (same scope reuses, genuinely
   * different scope surfaces BUDGET_EXCEEDED).
   */
  async requestHostCartoonJob(input: {
    partyId: string;
    deviceId: string;
    channelId: string;
    jobId: string;
    idempotencyKey: string;
    guestMediaId: string;
    seedId: string;
    rehearsalOnly?: true;
  }): Promise<RequestGenerationResult & { scenarioId: string; situationId: string }> {
    const partyId = validateId(input.partyId, "partyId");
    const deviceId = validateId(input.deviceId, "deviceId");
    const channelId = validateId(input.channelId, "channelId");
    const jobId = validateId(input.jobId, "jobId");
    const idempotencyKey = validateId(input.idempotencyKey, "idempotencyKey");
    const guestMediaId = validateId(input.guestMediaId, "guestMediaId");
    const seedId = validateId(input.seedId, "seedId");
    if (input.rehearsalOnly !== undefined && input.rehearsalOnly !== true) {
      throw new BackendError("INVALID_ARGUMENT", "rehearsalOnly must be true when present.");
    }
    if (!jobId.startsWith("hv-")) {
      throw new BackendError("INVALID_ARGUMENT", "Host cartoon jobs use the hv- job scope.");
    }
    await assertGuestEligible(this.db, { partyId, deviceId, channelId }, guestMediaId, this.now().getTime());
    const cartoonPlan = this.buildSharedCartoonPlan(guestMediaId);
    const created = await this.createJob({
      partyId,
      deviceId,
      channelId,
      jobId,
      idempotencyKey,
      presetId: CHEAP_DEMO_PRESET.presetId,
      guestMediaId,
      ...(input.rehearsalOnly ? { rehearsalOnly: true as const } : {}),
    }, cartoonPlan as unknown as Record<string, unknown>, { seedProvenance: { seedId, kind: "host" } });
    const plan = cartoonPlan as unknown as { scenarioId: string; situationId: string };
    return { ...created, scenarioId: plan.scenarioId, situationId: plan.situationId };
  }

  /** Shared creation path: requestGeneration (no plan) and the server auto path (server plan). */
  private async createJob(value: unknown, cartoonPlan: Record<string, unknown> | undefined, opts?: CreateJobOptions): Promise<RequestGenerationResult> {
    const rehearsalOnly = extractRehearsalOnly(value);
    const sanitized = stripCartoonPlan(stripRehearsalOnly(value));
    validatePresetControls(sanitized);
    if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) && "prompt" in sanitized) {
      const presetId = (sanitized as Record<string, unknown>).presetId === CAMEO_DEMO_PRESET.presetId ? "cameo_demo" : "cheap_demo";
      throw new BackendError("INVALID_ARGUMENT", `Generation prompts are fixed server-side for ${presetId}.`);
    }
    if (cartoonPlan !== undefined) {
      validateCartoonPlan(cartoonPlan);
    }
    const input = parseRequestGeneration(sanitized);
    const registered = await assertRegisteredPartyDevice(this.db, input);
    if (registered.channel.status !== "active") throw new BackendError("FORBIDDEN", "Channel is not active for this party.");
    // Consent-bound request gate: the guest photo must be eligible right now.
    // The worker and the publication transaction recheck before submitting and
    // before publishing, so a withdrawal races fail closed.
    let guest: GuestMediaDoc | undefined;
    if (input.guestMediaId) {
      guest = await assertGuestEligible(this.db, input, input.guestMediaId, this.now().getTime());
    }
    // Cartoon portrait binding: persist the chain-only portrait as the job's
    // guestMedia binding at request time so withdrawal (which matches both
    // guestMedia.submissionId and cartoonChain.portraitSubmissionId) always
    // finds the job — even when the request carried no guestMediaId.
    let cartoonPortrait: GuestMediaDoc | undefined;
    const cartoonPortraitId = (cartoonPlan as Record<string, unknown> | undefined)?.portraitSubmissionId;
    if (typeof cartoonPortraitId === "string" && cartoonPortraitId !== "" && !input.guestMediaId) {
      cartoonPortrait = await assertGuestEligible(this.db, input, cartoonPortraitId, this.now().getTime());
    }
    const ref = jobRef(this.db, input.partyId, input.jobId);
    const result = await this.db.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) {
        const old = existing.data()!;
        const newEffectiveGuestId = input.guestMediaId ?? (typeof cartoonPortraitId === "string" && cartoonPortraitId !== "" ? cartoonPortraitId : undefined);
        const oldSeed = (old.seedProvenance ?? undefined) as Record<string, unknown> | undefined;
        const newSeed = opts?.seedProvenance ? { seedId: opts.seedProvenance.seedId, kind: opts.seedProvenance.kind } : undefined;
        if (old.idempotencyKey !== input.idempotencyKey || old.deviceId !== input.deviceId || old.channelId !== input.channelId ||
            (old.guestMediaId ?? undefined) !== (newEffectiveGuestId ?? undefined) ||
            (old.rehearsalOnly === true) !== rehearsalOnly ||
            !cartoonPlansEqual(old.cartoonPlan ?? undefined, cartoonPlan) ||
            JSON.stringify(oldSeed ?? null) !== JSON.stringify(newSeed ?? null)) {
          throw new BackendError("FORBIDDEN", "jobId is already bound to a different request.");
        }
        return {
          state: String(old.state),
          created: false,
          manifestVersion: Number(old.manifestVersion),
          timestamp: old.timestamp,
        };
      }
      const inFlight = await transaction.get(
        this.db.collection(`parties/${input.partyId}/jobs`).where("state", "in", ["queued", "running"]).limit(1),
      );
      if (!inFlight.empty) throw new BackendError("BUDGET_EXCEEDED", "One generation is already in flight for this party.");
      await transaction.get(budgetRef(this.db, input.partyId));
      const current = await transaction.get(currentManifestRef(this.db, input.partyId, input.channelId));
      const sourceManifestVersion = current.exists ? Number(current.data()?.version ?? 0) : 0;
      if (!Number.isSafeInteger(sourceManifestVersion) || sourceManifestVersion < 0 || (current.exists && sourceManifestVersion < 1)) {
        throw new BackendError("MANIFEST_MISMATCH", "Current manifest version is invalid.");
      }
      const manifestVersion = sourceManifestVersion + 1;
      if (!Number.isSafeInteger(manifestVersion)) throw new BackendError("MANIFEST_MISMATCH", "Next manifest version is invalid.");
      const timestamp = FieldValue.serverTimestamp();
      const cameraAttempts = Object.fromEntries(REQUIRED_CAMERA_IDS.map((cameraId) => [cameraId, {
        consumedAttempt: false,
        submissionState: "not_started",
      }]));
      // Re-verify consent inside the creation transaction so a withdrawal that
      // lands between the pre-check and the job write fails the request.
      let guestBinding: Record<string, unknown> | undefined;
      const effectiveGuest = guest ?? cartoonPortrait;
      const effectiveGuestId = input.guestMediaId ?? (typeof cartoonPortraitId === "string" ? cartoonPortraitId : undefined);
      if (effectiveGuestId && effectiveGuest) {
        const guestSnap = await transaction.get(
          this.db.doc(`parties/${input.partyId}/guestMedia/${effectiveGuestId}`),
        );
        const current = guestSnap.exists ? (guestSnap.data() as GuestMediaDoc) : undefined;
        if (!current || current.status !== "eligible" ||
            !current.consent || current.consent.accepted !== true ||
            !isSupportedConsent(current.consent.textVersion, current.consent.purpose) ||
            current.sourceHash !== effectiveGuest.sourceHash ||
            current.consentRevision !== effectiveGuest.consentRevision ||
            current.deviceId !== input.deviceId || current.channelId !== input.channelId) {
          throw new BackendError("FORBIDDEN", "Guest consent is no longer eligible for generation.");
        }
        guestBinding = {
          submissionId: effectiveGuestId,
          objectPath: effectiveGuest.objectPath,
          sourceHash: effectiveGuest.sourceHash,
          sourceGeneration: effectiveGuest.sourceGeneration ?? null,
          consentRevision: effectiveGuest.consentRevision,
          deviceId: effectiveGuest.deviceId,
          channelId: effectiveGuest.channelId,
        };
        // Fail closed if a fetchable URL ever reaches the persistence path.
        assertNoSignedReferenceUrl(guestBinding);
      }
      transaction.create(ref, {
        jobId: input.jobId,
        partyId: registered.partyId,
        deviceId: registered.deviceId,
        channelId: registered.channelId,
        manifestVersion,
        sourceManifestVersion,
        state: "queued",
        status: "queued",
        timestamp,
        createdAt: timestamp,
        idempotencyKey: input.idempotencyKey,
        presetId: input.presetId,
        modelId: input.presetId === CAMEO_DEMO_PRESET.presetId ? CAMEO_DEMO_PRESET.modelId : CHEAP_DEMO_PRESET.modelId,
        // Positive server-written marker for unbound (text-only) jobs: the
        // delivery gate requires this marker when no consent/seed binding
        // exists. Bound jobs carry guestMedia instead and never get it.
        ...(guestBinding ? {} : { kind: "text-only" as const }),
        ...(rehearsalOnly ? { rehearsalOnly: true as const } : {}),
        // Server-written host seed binding (fix-5a): persisted atomically at
        // creation so delivery/publish resolve it without prefix inference.
        ...(opts?.seedProvenance ? { seedProvenance: { seedId: opts.seedProvenance.seedId, kind: opts.seedProvenance.kind } } : {}),
        ...(cartoonPlan ? { cartoonPlan } : {}),
        // Cartoon jobs begin with an empty chain; stages fill it in without
        // ever rewriting the immutable plan above.
        ...(cartoonPlan ? { cartoonChain: { stillStatus: "pending", videoStatus: "pending" } } : {}),
        ...(guestBinding ? { guestMedia: guestBinding, guestMediaId: effectiveGuestId } : {}),
        costEstimate: input.presetId === CAMEO_DEMO_PRESET.presetId
          ? { modelId: CAMEO_DEMO_PRESET.modelId, presetId: CAMEO_DEMO_PRESET.presetId, secondsOut: CAMEO_DEMO_PRESET.secondsOut }
          : { modelId: CHEAP_DEMO_PRESET.modelId, presetId: CHEAP_DEMO_PRESET.presetId, secondsOut: CHEAP_DEMO_PRESET.secondsOut },
        expiresAt: Timestamp.fromDate(new Date(this.now().getTime() + MEDIA_RETENTION_MS)),
        cameraAttempts,
        providerTasks: {},
        stagedOutputs: {},
      });
      transaction.set(budgetRef(this.db, input.partyId), {
        activeJobId: input.jobId,
        state: "in_flight",
        updatedAt: timestamp,
      }, { merge: true });
      for (const cameraId of REQUIRED_CAMERA_IDS) {
        transaction.create(this.db.doc(usageLedgerPath({
          partyId: input.partyId,
          deviceId: input.deviceId,
          channelId: input.channelId,
          manifestVersion,
          idempotencyKey: input.idempotencyKey,
          jobId: input.jobId,
          cameraId,
        })), usageIntentDocument({
          partyId: input.partyId,
          deviceId: input.deviceId,
          channelId: input.channelId,
          manifestVersion,
          idempotencyKey: input.idempotencyKey,
          jobId: input.jobId,
          cameraId,
        }, timestamp, input.presetId === CAMEO_DEMO_PRESET.presetId ? CAMEO_DEMO_PRESET : CHEAP_DEMO_PRESET));
      }
      // Cartoon still-stage intent row: per-stage usage from job creation,
      // unknown credits truthful (null), never estimated.
      if (cartoonPlan) {
        transaction.create(this.db.doc(cartoonStillLedgerPath(input.partyId, input.jobId)), cartoonStillIntentDocument({
          partyId: input.partyId,
          deviceId: input.deviceId,
          channelId: input.channelId,
          manifestVersion,
          idempotencyKey: input.idempotencyKey,
          jobId: input.jobId,
          cameraId: "CAM-01",
        }, timestamp));
      }
      return { state: "queued", created: true, manifestVersion, timestamp };
    });
    const persisted = (await ref.get()).data();
    return {
      jobId: input.jobId,
      partyId: input.partyId,
      deviceId: input.deviceId,
      channelId: input.channelId,
      state: result.state,
      created: result.created,
      manifestVersion: result.manifestVersion,
      timestamp: exposedTimestamp(persisted?.timestamp ?? result.timestamp),
      idempotencyKey: input.idempotencyKey,
    };
  }

  async getJob(partyId: string, jobId: string): Promise<FirebaseFirestore.DocumentData> {
    const ref = jobRef(this.db, validateId(partyId, "partyId"), validateId(jobId, "jobId"));
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
    return snapshot.data()!;
  }

  async getGenerationStatus(value: unknown): Promise<Record<string, unknown>> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new BackendError("INVALID_ARGUMENT", "Status query must be an object.");
    extractRehearsalOnly(value);
    const query = stripCartoonPlan(stripRehearsalOnly(value)) as Record<string, unknown>;
    validatePresetControls(query);
    if ("prompt" in query) {
      const presetId = query.presetId === CAMEO_DEMO_PRESET.presetId ? "cameo_demo" : "cheap_demo";
      throw new BackendError("INVALID_ARGUMENT", `Generation prompts are fixed server-side for ${presetId}.`);
    }
    const input: RequestGenerationInput = parseRequestGeneration({ ...query, presetId: query.presetId ?? "cheap_demo" });
    const registered = await assertRegisteredPartyDevice(this.db, input);
    if (registered.channel.status !== "active") throw new BackendError("FORBIDDEN", "Channel is not active for this party.");
    const job = await this.getJob(input.partyId, input.jobId);
    if (job.idempotencyKey !== input.idempotencyKey || job.deviceId !== input.deviceId || job.channelId !== input.channelId) {
      throw new BackendError("FORBIDDEN", "Job status identity does not match the request.");
    }
    return {
      jobId: input.jobId,
      partyId: job.partyId,
      deviceId: job.deviceId,
      channelId: job.channelId,
      manifestVersion: job.manifestVersion,
      timestamp: exposedTimestamp(job.timestamp),
      idempotencyKey: job.idempotencyKey,
      state: job.state,
      status: job.status ?? job.state,
      errorCode: job.errorCode,
      reconciliationReason: job.reconciliationReason,
    };
  }

  /** Records a task queue failure without allowing the worker to auto-retry it. */
  async failEnqueue(task: GenerationTask): Promise<void> {
    const ref = jobRef(this.db, task.partyId, task.jobId);
    const budget = budgetRef(this.db, task.partyId);
    await this.db.runTransaction(async (transaction) => {
      const [snapshot, budgetSnapshot] = await Promise.all([transaction.get(ref), transaction.get(budget)]);
      if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
      const job = snapshot.data()!;
      if (job.idempotencyKey !== task.idempotencyKey || job.deviceId !== task.deviceId || job.channelId !== task.channelId) {
        throw new BackendError("FORBIDDEN", "Task identity does not match the job.");
      }
      const timestamp = FieldValue.serverTimestamp();
      if (job.state === "queued") {
        transaction.update(ref, {
          state: "failed",
          status: "failed",
          errorCode: "PROVIDER_UNAVAILABLE",
          enqueueFailedAt: timestamp,
          failedAt: timestamp,
          timestamp,
        });
        if (budgetSnapshot.exists && budgetSnapshot.data()?.activeJobId === task.jobId) {
          transaction.update(budget, { activeJobId: null, state: "idle", updatedAt: timestamp });
        }
      } else {
        // A queue response can be lost after acceptance. Preserve a worker that
        // already claimed the job, while keeping the ambiguous enqueue visible.
        transaction.update(ref, { enqueueErrorCode: "PROVIDER_UNAVAILABLE", enqueueFailedAt: timestamp, timestamp });
      }
    });
  }

  async claimWorker(task: GenerationTask, leaseMs = 20 * 60 * 1000): Promise<{ claimed: boolean; job: FirebaseFirestore.DocumentData }> {
    const ref = jobRef(this.db, task.partyId, task.jobId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
      const job = snapshot.data()!;
      if (job.idempotencyKey !== task.idempotencyKey || job.deviceId !== task.deviceId || job.channelId !== task.channelId) {
        throw new BackendError("FORBIDDEN", "Worker identity does not match the job.");
      }
      if (["ready", "delivering", "failed", "expired", "purged"].includes(String(job.state))) return { claimed: false, job }; // delivering is terminal for the worker: the ACK path owns the job from here.
      const leaseUntil = Number(job.workerLeaseUntilMs ?? 0);
      if (job.state === "running" && leaseUntil > this.now().getTime()) return { claimed: false, job };
      const next = this.now().getTime() + leaseMs;
      transaction.update(ref, {
        state: "running",
        status: "running",
        workerLeaseUntilMs: next,
        startedAt: job.startedAt ?? FieldValue.serverTimestamp(),
        timestamp: FieldValue.serverTimestamp(),
      });
      return { claimed: true, job: { ...job, state: "running", workerLeaseUntilMs: next } };
    });
  }

  async heartbeat(partyId: string, jobId: string, leaseMs = 20 * 60 * 1000): Promise<void> {
    await jobRef(this.db, partyId, jobId).update({ workerLeaseUntilMs: this.now().getTime() + leaseMs, timestamp: FieldValue.serverTimestamp() });
  }

  async beginSubmission(partyId: string, jobId: string, cameraId: CameraId): Promise<boolean> {
    const ref = jobRef(this.db, partyId, jobId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
      const job = snapshot.data()!;
      const task = (job.providerTasks ?? {})[cameraId] as Record<string, unknown> | undefined;
      if (typeof task?.taskId === "string") return false;
      const attempts = { ...(job.cameraAttempts ?? {}) } as Record<string, Record<string, unknown>>;
      const attempt = attempts[cameraId] ?? {};
      if (attempt.consumedAttempt === true) {
        if (attempt.submissionState === "submitting") {
          throw new BackendError("PROVIDER_UNAVAILABLE", "Provider submission outcome is unknown; automatic resubmission is disabled.");
        }
        throw new BackendError("PROVIDER_UNAVAILABLE", "Provider submission attempt has already been consumed.");
      }
      attempts[cameraId] = {
        ...attempt,
        consumedAttempt: true,
        submissionState: "submitting",
        submissionStartedAt: FieldValue.serverTimestamp(),
      };
      transaction.update(ref, { cameraAttempts: attempts, timestamp: FieldValue.serverTimestamp() });
      return true;
    });
  }

  async recordSubmission(
    partyId: string,
    jobId: string,
    cameraId: CameraId,
    taskId: string,
  ): Promise<void> {
    const ref = jobRef(this.db, partyId, jobId);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
      const job = snapshot.data()!;
      const old = (job.providerTasks ?? {})[cameraId] as Record<string, unknown> | undefined;
      if (typeof old?.taskId === "string" && old.taskId !== taskId) {
        throw new BackendError("FORBIDDEN", "A different provider task is already persisted for this camera.");
      }
      const providerTasks = { ...(job.providerTasks ?? {}), [cameraId]: { taskId, submittedAt: FieldValue.serverTimestamp() } };
      const cameraAttempts = { ...(job.cameraAttempts ?? {}) } as Record<string, Record<string, unknown>>;
      cameraAttempts[cameraId] = { ...(cameraAttempts[cameraId] ?? {}), submissionState: "submitted" };
      transaction.update(ref, { providerTasks, cameraAttempts, timestamp: FieldValue.serverTimestamp() });
    });
  }

  async recordSubmissionFailure(
    input: RequestGenerationInput,
    cameraId: CameraId,
    errorCode: string,
    certainty: "non_billable" | "unknown",
  ): Promise<void> {
    const ref = jobRef(this.db, input.partyId, input.jobId);
    const budget = budgetRef(this.db, input.partyId);
    await this.db.runTransaction(async (transaction) => {
      const [snapshot, budgetSnapshot] = await Promise.all([transaction.get(ref), transaction.get(budget)]);
      if (!snapshot.exists) return;
      const job = snapshot.data()!;
      const cameraAttempts = { ...(job.cameraAttempts ?? {}) } as Record<string, Record<string, unknown>>;
      cameraAttempts[cameraId] = {
        ...(cameraAttempts[cameraId] ?? {}),
        submissionState: certainty === "non_billable" ? "rejected_non_billable" : "submitting",
        submissionErrorCode: errorCode,
      };
      transaction.update(ref, {
        cameraAttempts,
        state: certainty === "unknown" ? "running" : "failed",
        status: certainty === "unknown" ? "reconciliation_required" : "failed",
        errorCode: "PROVIDER_UNAVAILABLE",
        ...(certainty === "unknown" ? { reconciliationReason: "SUBMISSION_OUTCOME_UNKNOWN" } : {}),
        ...(certainty === "non_billable" ? { failedAt: FieldValue.serverTimestamp() } : {}),
        timestamp: FieldValue.serverTimestamp(),
        workerLeaseUntilMs: 0,
      });
      if (certainty === "non_billable" && budgetSnapshot.exists && budgetSnapshot.data()?.activeJobId === input.jobId) {
        transaction.update(budget, { activeJobId: null, state: "idle", updatedAt: FieldValue.serverTimestamp() });
      }
    });
  }

  async recordCameraResult(
    partyId: string,
    jobId: string,
    cameraId: CameraId,
    result: ProviderResult,
    taskStatus: ProviderTaskStatus,
    staged: Record<string, unknown>,
  ): Promise<void> {
    const ref = jobRef(this.db, partyId, jobId);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
      const job = snapshot.data()!;
      const stagedOutputs = { ...(job.stagedOutputs ?? {}), [cameraId]: staged };
      const cameraResults = { ...(job.cameraResults ?? {}), [cameraId]: {
        secondsOut: result.secondsOut,
        secondsIn: result.secondsIn,
        creditsCharged: result.creditsCharged,
        providerState: taskStatus.state,
      } };
      const cameraAttempts = { ...(job.cameraAttempts ?? {}) } as Record<string, Record<string, unknown>>;
      cameraAttempts[cameraId] = { ...(cameraAttempts[cameraId] ?? {}), submissionState: "complete", providerState: taskStatus.state };
      transaction.update(ref, {
        stagedOutputs,
        cameraResults,
        cameraAttempts,
        timestamp: FieldValue.serverTimestamp(),
      });
    });
  }

  /** Fixture slot outcome: no provider task, truthful fixture provenance. */
  async recordFixtureResult(
    partyId: string,
    jobId: string,
    cameraId: CameraId,
    staged: Record<string, unknown>,
    secondsOut = 2,
  ): Promise<void> {
    const ref = jobRef(this.db, partyId, jobId);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
      const job = snapshot.data()!;
      transaction.update(ref, {
        stagedOutputs: { ...(job.stagedOutputs ?? {}), [cameraId]: staged },
        cameraResults: {
          ...(job.cameraResults ?? {}),
          [cameraId]: { secondsOut, secondsIn: 0, creditsCharged: null, providerState: "FIXTURE" },
        },
        timestamp: FieldValue.serverTimestamp(),
      });
    });
  }

  /** Consent withdrawal fails the bound job closed and releases the party budget. */
  async failForWithdrawnConsent(partyId: string, jobId: string): Promise<void> {
    const ref = jobRef(this.db, partyId, jobId);
    const budget = budgetRef(this.db, partyId);
    await this.db.runTransaction(async (transaction) => {
      const [snapshot, budgetSnapshot] = await Promise.all([transaction.get(ref), transaction.get(budget)]);
      if (!snapshot.exists) return;
      transaction.update(ref, {
        state: "failed",
        status: "failed",
        errorCode: "FORBIDDEN",
        reconciliationReason: "GUEST_CONSENT_WITHDRAWN",
        failedAt: FieldValue.serverTimestamp(),
        timestamp: FieldValue.serverTimestamp(),
        workerLeaseUntilMs: 0,
      });
      if (budgetSnapshot.exists && budgetSnapshot.data()?.activeJobId === jobId) {
        transaction.update(budget, { activeJobId: null, state: "idle", updatedAt: FieldValue.serverTimestamp() });
      }
    });
  }

  async recordProviderFailure(input: RequestGenerationInput, cameraId: CameraId, errorCode: string): Promise<void> {
    const ref = jobRef(this.db, input.partyId, input.jobId);
    const budget = budgetRef(this.db, input.partyId);
    await this.db.runTransaction(async (transaction) => {
      const [jobSnapshot, budgetSnapshot] = await Promise.all([transaction.get(ref), transaction.get(budget)]);
      if (!jobSnapshot.exists) return;
      transaction.update(ref, {
        state: "failed",
        status: "failed",
        errorCode: "PROVIDER_UNAVAILABLE",
        providerErrorCode: errorCode.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80),
        failedAt: FieldValue.serverTimestamp(),
        timestamp: FieldValue.serverTimestamp(),
        workerLeaseUntilMs: 0,
        [`cameraAttempts.${cameraId}.providerState`]: "FAILED",
      });
      if (budgetSnapshot.exists && budgetSnapshot.data()?.activeJobId === input.jobId) {
        transaction.update(budget, { activeJobId: null, state: "idle", updatedAt: FieldValue.serverTimestamp() });
      }
    });
  }

  async recordStagedOutput(partyId: string, jobId: string, cameraId: CameraId, staged: Record<string, unknown>): Promise<void> {
    const ref = jobRef(this.db, partyId, jobId);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
      const job = snapshot.data()!;
      transaction.update(ref, {
        stagedOutputs: { ...(job.stagedOutputs ?? {}), [cameraId]: staged },
        timestamp: FieldValue.serverTimestamp(),
      });
    });
  }

  async releaseWorker(partyId: string, jobId: string): Promise<void> {
    await jobRef(this.db, partyId, jobId).update({ workerLeaseUntilMs: 0, timestamp: FieldValue.serverTimestamp() });
  }

  /**
   * Cartoon still-stage guards: idempotent submit-once + resume without a
   * duplicate billable still submission. Mirrors beginSubmission/recordSubmission
   * for the CAM-01 video stage but keys on the still idempotency key.
   */
  async beginStillSubmission(partyId: string, jobId: string): Promise<boolean> {
    const ref = jobRef(this.db, partyId, jobId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
      const job = snapshot.data()!;
      const chain = (job.cartoonChain ?? {}) as Record<string, unknown>;
      if (typeof chain.stillTaskId === "string" || chain.stillStatus === "completed") return false;
      if (chain.stillSubmissionState === "submitting") {
        throw new BackendError("PROVIDER_UNAVAILABLE", "Cartoon still submission outcome is unknown; automatic resubmission is disabled.");
      }
      if (chain.stillSubmissionConsumed === true) {
        throw new BackendError("PROVIDER_UNAVAILABLE", "Cartoon still submission attempt has already been consumed.");
      }
      transaction.update(ref, {
        "cartoonChain.stillSubmissionConsumed": true,
        "cartoonChain.stillSubmissionState": "submitting",
        timestamp: FieldValue.serverTimestamp(),
      });
      return true;
    });
  }

  async recordStillSubmission(partyId: string, jobId: string, taskId: string): Promise<void> {
    const ref = jobRef(this.db, partyId, jobId);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
      const job = snapshot.data()!;
      const chain = (job.cartoonChain ?? {}) as Record<string, unknown>;
      const old = chain.stillTaskId as unknown;
      if (typeof old === "string" && old !== taskId) {
        throw new BackendError("FORBIDDEN", "A different cartoon still task is already persisted for this job.");
      }
      transaction.update(ref, {
        "cartoonChain.stillTaskId": taskId,
        "cartoonChain.stillSubmissionState": "submitted",
        timestamp: FieldValue.serverTimestamp(),
      });
    });
  }

  async recordStillResult(
    partyId: string,
    jobId: string,
    stillSha256: string,
    stillPath: string,
    portraitSubmissionId?: string,
    portraitSourceHash?: string,
    portraitConsentRevision?: string,
    opts?: { stillFixture?: boolean },
  ): Promise<void> {
    const ref = jobRef(this.db, partyId, jobId);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
      transaction.update(ref, {
        "cartoonChain.stillSha256": stillSha256,
        "cartoonChain.stillPath": stillPath,
        "cartoonChain.stillStatus": "completed",
        // videoStillSha256 is bound at video-submit time from the in-flight
        // firstFrame sha (see recordCartoonVideoStaged), never here: the
        // still-stage write must not pre-bind the video-stage proof.
        ...(opts?.stillFixture === true ? { "cartoonChain.stillFixture": true } : {}),
        ...(portraitSubmissionId !== undefined ? { "cartoonChain.portraitSubmissionId": portraitSubmissionId } : {}),
        ...(portraitSourceHash !== undefined ? { "cartoonChain.portraitSourceHash": portraitSourceHash } : {}),
        ...(portraitConsentRevision !== undefined ? { "cartoonChain.portraitConsentRevision": portraitConsentRevision } : {}),
        timestamp: FieldValue.serverTimestamp(),
      });
    });
  }

  async recordCartoonVideoStaged(partyId: string, jobId: string, videoStillSha256?: string): Promise<void> {
    const ref = jobRef(this.db, partyId, jobId);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new BackendError("NOT_FOUND", "Generation job does not exist.");
      transaction.update(ref, {
        "cartoonChain.videoStatus": "staged",
        ...(typeof videoStillSha256 === "string" && /^[a-f0-9]{64}$/.test(videoStillSha256)
          ? { "cartoonChain.videoStillSha256": videoStillSha256 }
          : {}),
        timestamp: FieldValue.serverTimestamp(),
      });
    });
  }

  currentManifestRef(partyId: string, channelId: string) {
    return currentManifestRef(this.db, partyId, channelId);
  }

  jobDocumentRef(partyId: string, jobId: string) {
    return jobRef(this.db, partyId, jobId);
  }

  plannedObjectPath(partyId: string, channelId: string, version: number, cameraId: CameraId): string {
    return deliveryObjectPath(partyId, channelId, version, cameraId);
  }
}

