/**
 * Before the model answers a message that points back at an earlier answer, re-read the pages that
 * answer's facts came from and diff its quotes against them (`domain/diff.ts`).
 *
 * The reads run in parallel and get a few seconds; whatever is not back by then is reported as
 * still loading, for the model to search itself. The pages read become sources the answer can cite
 * and quote, like any search result.
 */
import { checkable, quoteDiff, type DiffRow } from "../domain/diff.ts";
import type { Activity, Claim } from "../domain/memory.ts";
import type { SourceBook } from "./sources.ts";
import type { SearchService } from "./web-search.ts";

const MAX_PAGES = 8;
const WAIT_MS = 4000;

export async function recheck(
  baseline: Claim[],
  search: SearchService,
  book: SourceBook,
  report: (activity: Activity) => void,
  signal?: AbortSignal,
): Promise<string> {
  const facts = checkable(baseline);
  const urls = [...new Set(facts.map((c) => c.sourceUrl!))].slice(0, MAX_PAGES);
  if (!urls.length) return "";

  const lane: Activity = { kind: "search", id: "recheck", query: `Re-reading ${urls.length} page${urls.length === 1 ? "" : "s"} the earlier answer quoted`, fresh: true, ahead: true };
  report(lane);
  const reading = search.read(urls, signal).catch(() => []);
  const pages = await Promise.race([reading, new Promise<null>((r) => setTimeout(() => r(null), WAIT_MS))]);
  if (!pages) {
    report({ ...lane, failed: "still loading" });
    return `\n\n<rechecked written-by="system">\nThe pages your earlier answer quoted were still loading. Re-read them yourself (web_search on the vendor's site, fresh).\n</rechecked>`;
  }

  const readable = pages.filter((p) => p.readable);
  const ids = book.enter(readable, { fresh: true });
  report({ ...lane, results: readable.length, hits: ids });
  const rows = quoteDiff(facts.filter((c) => urls.includes(c.sourceUrl!)), new Map(pages.map((p) => [p.url, p.readable ? p.text : undefined])));
  const idOf = new Map(readable.map((p) => [p.url, p.id]));
  return (
    `\n\n<rechecked written-by="system">\nThe pages your earlier answer quoted, re-read live just now, with each quote looked up word for word. ` +
    `"still there" means the page says what it said then. "gone" means the quoted words are no longer on the page; the closest passage now is shown. ` +
    `Cite these pages by their ids like any search result.\n` +
    rows.map((r) => row(r, idOf.get(r.url))).join("\n") +
    `\n</rechecked>`
  );
}

function row(r: DiffRow, id?: string): string {
  const where = `${id ? `[${id}] ` : ""}${r.url}`;
  if (r.status === "still there") return `- ${r.subject}: ${r.value}. Quote "${r.quote}": still there (${where}).`;
  if (r.status === "page unreadable") return `- ${r.subject}: ${r.value}. ${where} could not be read; check it yourself.`;
  return `- ${r.subject}: ${r.value}. Quote "${r.quote}": gone from ${where}.${r.nearest ? ` Closest passage now: "${r.nearest}"` : ""}`;
}
