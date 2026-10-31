/** Server-owned, two-stage cartoon prompt composition. */
export interface CartoonPromptSelection {
  subject: string;
  action: string;
  sceneStyle: string;
}

export interface CartoonPrompts { still: string; motion: string; negative: string }

export function composeCartoonPrompts(selection: CartoonPromptSelection): CartoonPrompts {
  for (const value of Object.values(selection)) {
    if (typeof value !== "string" || !value.trim() || value.length > 1200) {
      throw new Error("Cartoon prompt selection is invalid.");
    }
  }
  return {
    still: `Subject and identity: Use the person in the subject_identity reference as the character identity. ${selection.subject} Completely redraw the person as a coherent, fully illustrated cartoon character; preserve recognizable identity without photographic skin or pasted photographic details.\nAction event: ${selection.action}\nScene and style: ${selection.sceneStyle}\nNegative prompt: no photographic skin, no pasted photo, no identity substitution, no extra people, no text, no watermark.`,
    motion: `Animate the supplied illustrated first frame with tiny natural motion only. ${selection.action} Locked camera, no cuts, preserve the illustrated character identity and scene.`,
    negative: "photographic skin, pasted photographic face, identity substitution, photorealism, text, watermark, camera movement",
  };
}
