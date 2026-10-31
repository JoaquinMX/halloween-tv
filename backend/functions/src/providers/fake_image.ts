import { ImageGenerationPort, CartoonStillRequest, CartoonStillResult } from "../image_generation_port";
import { sha256 } from "../cartoon_pipeline";

/** Offline image port: deterministic SVG bytes, never invokes a provider. */
export class FakeImageGenerationPort implements ImageGenerationPort {
  readonly submissions: string[] = [];
  async generate(request: CartoonStillRequest): Promise<CartoonStillResult> {
    const old = this.submissions.find((key) => key === request.idempotencyKey);
    if (!old) this.submissions.push(request.idempotencyKey);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="#888"/><text x="1" y="5">offline cartoon fixture</text></svg>`;
    const image = new TextEncoder().encode(svg);
    return { image, taskId: `fake_${sha256(new TextEncoder().encode(request.idempotencyKey)).slice(0, 24)}`, creditsCharged: 0 };
  }
}
