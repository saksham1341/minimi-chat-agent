/**
 * Corrections as edits, not rewrites. When an answer's citations do not hold up, the model sends
 * back only what changes: each edit names a passage of its answer exactly and what it becomes.
 * Software applies them, so the rest of the answer stays as it was, on screen and on record, and
 * a fix costs a few hundred tokens instead of the whole answer again.
 */
import { z } from "zod";

export const Fixes = z.object({
  edits: z
    .array(
      z.object({
        find: z.string().min(1).describe("A passage of your answer, copied exactly: the citation and the words around it that change."),
        replace: z.string().describe("What the passage becomes. Empty to drop it."),
      }),
    )
    .min(1)
    .max(20),
});
export type Edit = z.infer<typeof Fixes>["edits"][number];

/** Applies each edit at its passage's first occurrence. Edits whose passage is not there are returned as missed. */
export function applyEdits(text: string, edits: Edit[]): { text: string; applied: Edit[]; missed: Edit[] } {
  const applied: Edit[] = [];
  const missed: Edit[] = [];
  for (const edit of edits) {
    const at = text.indexOf(edit.find);
    if (at < 0) {
      missed.push(edit);
      continue;
    }
    text = text.slice(0, at) + edit.replace + text.slice(at + edit.find.length);
    applied.push(edit);
  }
  return { text, applied, missed };
}
