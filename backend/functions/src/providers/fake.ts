import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REQUIRED_CAMERA_IDS } from "../config";
import {
  CameraId,
  ProviderResult,
  ProviderSubmission,
  ProviderTaskStatus,
  VideoGenerationPort,
  VideoGenerationRequest,
  validateVideoGenerationRequest,
} from "../video_generation_port";

/** Offline provider backed by the repository's four deterministic MP4 fixtures. */
export class FakeVideoGenerationPort implements VideoGenerationPort {
  private readonly byKey = new Map<string, string>();
  private readonly byRequest = new Map<string, VideoGenerationRequest>();
  private readonly fixtureDirectory: string;

  constructor(fixtureDirectory = resolve(process.cwd(), "../../apps/tv_app/assets")) {
    this.fixtureDirectory = fixtureDirectory;
  }

  async submit(request: VideoGenerationRequest): Promise<ProviderSubmission> {
    validateVideoGenerationRequest(request);
    // Offline parity with the live adapter: a bound reference must already be
    // resolved to a fetchable signed https URL. Bare internal bucket paths
    // without a URL are rejected here, never silently accepted.
    if (request.referenceImage !== undefined) {
      const url = (request.referenceImage as { url?: unknown }).url;
      if (typeof url !== "string" || !/^https:\/\//.test(url)) {
        throw new Error("Fake provider reference image must carry a signed https URL.");
      }
    }
    const oldTaskId = this.byKey.get(request.idempotencyKey);
    if (oldTaskId) return { taskId: oldTaskId };
    const taskId = `${request.cameraId}__${createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 24)}`;
    this.byKey.set(request.idempotencyKey, taskId);
    this.byRequest.set(taskId, { ...request });
    return { taskId };
  }

  async getStatus(taskId: string): Promise<ProviderTaskStatus> {
    this.cameraFromTask(taskId);
    return { state: "SUCCEEDED" };
  }

  async getResult(taskId: string): Promise<ProviderResult> {
    const cameraId = this.cameraFromTask(taskId);
    const index = REQUIRED_CAMERA_IDS.indexOf(cameraId);
    const path = resolve(this.fixtureDirectory, `cam${String(index + 1).padStart(2, "0")}.mp4`);
    if (!existsSync(path)) throw new Error(`Offline fake fixture is missing for ${cameraId}.`);
    // Offline shape follows the submitted preset: cheap_demo reports 2s, the
    // STEP 2 cameo batch reports 5s. Unknown task IDs keep the legacy 2s
    // shape so pre-existing callers are unaffected.
    const submitted = this.byRequest.get(taskId);
    return {
      video: { kind: "file", value: path },
      secondsOut: submitted?.secondsOut ?? 2,
      secondsIn: 0,
      creditsCharged: 0,
    };
  }

  private cameraFromTask(taskId: string): CameraId {
    const cameraId = taskId.split("__", 1)[0] as CameraId;
    if (!REQUIRED_CAMERA_IDS.includes(cameraId) || !/^([A-Z0-9-]+)__[a-f0-9]{24}$/.test(taskId)) {
      throw new Error("Fake provider task ID is invalid.");
    }
    return cameraId;
  }
}

export function createVideoGenerationProviderFromEnvironment(fixtureDirectory?: string): VideoGenerationPort {
  const selected = (process.env.VIDEO_GENERATION_PROVIDER ?? "fake").trim().toLowerCase();
  if (selected === "fake") {
    return new FakeVideoGenerationPort(
      typeof fixtureDirectory === "string" && fixtureDirectory.trim() !== "" ? fixtureDirectory : undefined,
    );
  }
  if (selected === "alibaba") {
    // Lazy import avoids requiring provider credentials when the offline provider is selected.
    const { createAlibabaProviderFromEnvironment } = require("./alibaba") as typeof import("./alibaba");
    return createAlibabaProviderFromEnvironment();
  }
  throw new Error("VIDEO_GENERATION_PROVIDER must be either fake or alibaba.");
}
