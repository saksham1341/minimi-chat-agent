/**
 * Topic annotations: the answering model marks the main subjects of its answer inline, the first
 * time each appears, as `[[Neon]]` or `[[managed Postgres hosting]]`. Wiki-link syntax, which
 * models write reliably and which cannot be mistaken for a citation (`[S3f2a1 "…"]`).
 *
 * Two uses, for the cost of a few characters in the answer: the screen highlights them, and they
 * are the terms of the exchange's default index card, saved the moment the answer is done, before
 * the background indexer writes the full one (`services/indexer.ts`).
 */

const TOPIC = /\[\[([^[\]\n]{1,80})\]\]/g;
/** Code is quoted verbatim: `[[package]]` in a TOML block is not a topic. */
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

/** The topics marked in an answer, in order, each once. */
export function topicsIn(text: string): string[] {
  const prose = text.replace(CODE, " ");
  return [...new Set([...prose.matchAll(TOPIC)].map((m) => m[1].trim()).filter(Boolean))];
}

/** The answer as plain text: the marks removed, the words kept. Code is left as it is. */
export function withoutTopics(text: string): string {
  return text.replace(new RegExp(`${CODE.source}|${TOPIC.source}`, "g"), (m, topic?: string) => topic ?? m);
}
