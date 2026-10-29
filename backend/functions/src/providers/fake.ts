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
  private readonly fixtureDirectory: string;

  constructor(fixtureDirectory = resolve(process.cwd(), "../../apps/tv_app/assets")) {
    this.fixtureDirectory = fixtureDirectory;
  }

  async submit(request: VideoGenerationRequest): Promise<ProviderSubmission> {
    validateVideoGenerationRequest(request);
    const oldTaskId = this.byKey.get(request.idempotencyKey);
    if (oldTaskId) return { taskId: oldTaskId };
    const taskId = `${request.cameraId}__${createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 24)}`;
    this.byKey.set(request.idempotencyKey, taskId);
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
    return {
      video: { kind: "file", value: path },
      secondsOut: 2,
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

export function createVideoGenerationProviderFromEnvironment(): VideoGenerationPort {
  const selected = (process.env.VIDEO_GENERATION_PROVIDER ?? "fake").trim().toLowerCase();
  if (selected === "fake") return new FakeVideoGenerationPort();
  if (selected === "alibaba") {
    // Lazy import avoids requiring provider credentials when the offline provider is selected.
    const { createAlibabaProviderFromEnvironment } = require("./alibaba") as typeof import("./alibaba");
    return createAlibabaProviderFromEnvironment();
  }
  throw new Error("VIDEO_GENERATION_PROVIDER must be either fake or alibaba.");
}
