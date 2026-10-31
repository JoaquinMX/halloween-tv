import { createHash } from "node:crypto";
import { CartoonStillRequest, ImageGenerationPort } from "./image_generation_port";

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Validates the ordered, role-distinct references immediately before transport. */
export async function generateCartoonStill(port: ImageGenerationPort, request: CartoonStillRequest) {
  const [identity, scene] = request.references;
  if (identity.role !== "subject_identity" || scene.role !== "style_scene" || identity === scene) {
    throw new Error("Cartoon references must be separate subject_identity and style_scene inputs.");
  }
  for (const reference of request.references) {
    if (!reference.bytes.length || sha256(reference.bytes) !== reference.sha256) {
      throw new Error("Cartoon reference bytes do not match their recorded digest.");
    }
  }
  const result = await port.generate(request);
  if (!result.image.length) throw new Error("Cartoon image provider returned an empty still.");
  return { ...result, sha256: sha256(result.image) };
}
