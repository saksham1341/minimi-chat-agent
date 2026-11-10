/**
 * Citations found by a second run, not written by the answering one.
 *
 * The answer tags each fact with the page it came from, `[S3f2a1]`, and writes nothing more: no
 * quotes, nothing to fix. A citation run reads the answer as it is written and, for each claim,
 * finds the words on a page that state it (`services/citer.ts`). Software attaches them where the
 * claim ends, replacing the page tag there. Whether each quote is really on the page, and says
 * the sentence's figure, is still checked by lookup (`domain/quotes.ts`), and shown when not.
 */
import { z } from "zod";

export const Citations = z.object({
  citations: z
    .array(
      z.object({
        after: z
          .string()
          .min(1)
          .describe("The exact words of the answer that end the claim, 3 to 12 words, copied exactly, up to but not including any [S…] tag that follows them."),
        sources: z
          .array(
            z.object({
              id: z.string().describe("The page's id, e.g. S3f2a1."),
              quote: z.string().min(1).describe("The words in that page's passage that state the claim, with its figure, copied exactly (5 to 30 words; ... for words left out)."),
            }),
          )
          .describe("Every page whose passage states the claim. Empty if none does."),
      }),
    )
    .describe("Every checkable claim in this part of the answer, in order. Empty if it has none."),
});
export type Citation = z.infer<typeof Citations>["citations"][number];

const TAG = String.raw`\[S\d[0-9a-f]*[^\]\n]*\]`;
/** Page tags (and any punctuation and space before them) right after a claim. */
const FOLLOWING = new RegExp(`^([ \\t]*)((?:${TAG}[ \\t]*)+)`);
/** The same, copied into the claim's own words: they are not part of what the answer said. */
const TRAILING = new RegExp(`(?:[ \\t]*${TAG})+[ \\t]*$`);

/**
 * The answer with each found citation attached where its claim ends, replacing the page tags the
 * answer wrote there. Claims are looked for in order; one whose words are not in the answer, or
 * with no source found, leaves the answer as it was there.
 */
export function attachCitations(text: string, found: Citation[]): string {
  let cursor = 0;
  for (const c of found) {
    const cites = c.sources.map((s) => `[${s.id} "${s.quote.replace(/"/g, "'").replace(/\s+/g, " ").trim()}"]`).join("");
    const after = c.after.replace(TRAILING, "").trim();
    if (!cites || !after) continue;
    let at = text.indexOf(after, cursor);
    if (at < 0) at = text.indexOf(after);
    if (at < 0) continue;
    const end = at + after.length;
    const rest = text.slice(end);
    const tags = rest.match(FOLLOWING);
    const tail = tags ? rest.slice(tags[0].length) : rest;
    const join = tail && !/^[\s.,;:!?)]/.test(tail) ? " " : "";
    text = `${text.slice(0, end)} ${cites}${join}${tail}`;
    cursor = end + cites.length + 1;
  }
  return text;
}
