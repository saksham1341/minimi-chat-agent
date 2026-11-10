/**
 * Re-checking an earlier answer by its own quotes: is what the page said then still on the page
 * now? A word-for-word lookup, so its result is a fact, not a judgement. Where the quote has gone,
 * the passage on today's page that shares most words with it is shown beside it, which is usually
 * where the change is.
 */
import type { Claim } from "./memory.ts";
import { quoteFound } from "./quotes.ts";
import { normalise } from "./text.ts";

export type DiffStatus = "still there" | "gone" | "page unreadable";

export interface DiffRow {
  subject: string;
  value: string;
  quote: string;
  url: string;
  status: DiffStatus;
  /** For a quote that has gone: the closest passage on the page today. */
  nearest?: string;
}

/** Only facts with a quote and a source can be checked this way. */
export function checkable(claims: Claim[]): Claim[] {
  return claims.filter((c) => c.quote && c.sourceUrl);
}

export function quoteDiff(claims: Claim[], pages: Map<string, string | undefined>): DiffRow[] {
  return checkable(claims).map((c) => {
    const page = pages.get(c.sourceUrl!);
    const base = { subject: c.subject, value: c.value, quote: c.quote!, url: c.sourceUrl! };
    if (!page) return { ...base, status: "page unreadable" as const };
    if (quoteFound(c.quote!, page)) return { ...base, status: "still there" as const };
    return { ...base, status: "gone" as const, nearest: nearest(page, `${c.subject} ${c.quote}`) };
  });
}

/** The line or sentence of the page sharing most words with `probe`. */
export function nearest(page: string, probe: string): string | undefined {
  const want = new Set(normalise(probe).split(" ").filter((w) => w.length > 2));
  let best: { text: string; score: number } | undefined;
  for (const piece of page.split(/\n+|(?<=[.!?])\s+/)) {
    const text = piece.trim();
    if (text.length < 8 || text.length > 400) continue;
    const words = new Set(normalise(text).split(" "));
    const score = [...want].filter((w) => words.has(w)).length;
    if (score && (!best || score > best.score)) best = { text, score };
  }
  return best?.text;
}
