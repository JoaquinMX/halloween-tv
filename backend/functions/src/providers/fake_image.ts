import { ImageGenerationPort, CartoonStillRequest, CartoonStillResult } from "../image_generation_port";
import { sha256 } from "../cartoon_pipeline";

/** Offline image port: deterministic SVG bytes, never invokes a provider. */
export class FakeImageGenerationPort implements ImageGenerationPort {
  readonly submissions: string[] = [];
  private readonly byKey = new Map<string, CartoonStillResult & { taskId: string }>();

  async submit(request: CartoonStillRequest): Promise<{ taskId: string }> {
    const taskId = `still_${sha256(new TextEncoder().encode(request.idempotencyKey)).slice(0, 24)}`;
    if (!this.byKey.has(request.idempotencyKey)) {
      this.submissions.push(request.idempotencyKey);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="#888"/><text x="1" y="5">offline cartoon fixture</text></svg>`;
      const image = new TextEncoder().encode(svg);
      this.byKey.set(request.idempotencyKey, { image, taskId, creditsCharged: 0 });
    }
    return { taskId: this.byKey.get(request.idempotencyKey)!.taskId };
  }

  async getStatus(taskId: string): Promise<{ state: "SUCCEEDED" }> {
    if (!/^still_[a-f0-9]{24}$/.test(taskId) && !/^fake_[a-f0-9]{24}$/.test(taskId)) {
      throw new Error("Fake image task ID is invalid.");
    }
    return { state: "SUCCEEDED" };
  }

  async getResult(taskId: string): Promise<CartoonStillResult> {
    for (const result of this.byKey.values()) {
      if (result.taskId === taskId) return { ...result, image: new Uint8Array(result.image) };
    }
    throw new Error("Fake image task is unknown.");
  }

  async generate(request: CartoonStillRequest): Promise<CartoonStillResult> {
    const old = this.submissions.find((key) => key === request.idempotencyKey);
    if (!old) this.submissions.push(request.idempotencyKey);
    const existing = this.byKey.get(request.idempotencyKey);
    if (existing) return { ...existing, image: new Uint8Array(existing.image) };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="#888"/><text x="1" y="5">offline cartoon fixture</text></svg>`;
    const image = new TextEncoder().encode(svg);
    const result = { image, taskId: `still_${sha256(new TextEncoder().encode(request.idempotencyKey)).slice(0, 24)}`, creditsCharged: 0 as const };
    this.byKey.set(request.idempotencyKey, result);
    return { ...result, image: new Uint8Array(result.image) };
  }
}
