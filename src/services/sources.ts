/**
 * The sources of one conversation, as the chat service sees them. Built from what the run
 * reports, never from inside the search service: each search result that comes back through the
 * run is entered here once, given a number for the screen (1, 2, 3, in the order pages were first
 * found), and its text kept as the snapshot the answer's quotes are checked against.
 *
 * The model cites by the page's stable id ([S3f2a1 "..."]); people see the number.
 */
import type { Source } from "../domain/memory.ts";
import type { SearchResult } from "./web-search.ts";

export class SourceBook {
  /** Every source this conversation knows, earlier turns' first. */
  readonly sources: Source[] = [];
  /** The exact text each source showed the model: what its quotes are checked against. */
  readonly snapshots = new Map<string, string>();
  private readonly byId = new Map<string, Source>();
  private readonly foundNow = new Set<string>();

  constructor(prior?: { sources: Source[]; snapshots: ReadonlyMap<string, string> }) {
    for (const source of prior?.sources ?? []) {
      if (this.byId.has(source.id)) continue;
      this.sources.push(source);
      this.byId.set(source.id, source);
    }
    for (const [id, text] of prior?.snapshots ?? []) this.snapshots.set(id, text);
  }

  /** Enter one search's results; returns their ids in order. */
  enter(results: SearchResult[], read: { fresh?: boolean }): string[] {
    return results.map((r) => {
      this.foundNow.add(r.id);
      // A page read twice keeps both readings: a quote from either one is a quote from the page.
      const before = this.snapshots.get(r.id);
      this.snapshots.set(r.id, before && !before.includes(r.text) ? `${before}\n\n${r.text}` : before ?? r.text);
      const known = this.byId.get(r.id);
      if (known) {
        if (read.fresh) known.live = true;
        return r.id;
      }
      const source: Source = {
        id: r.id,
        n: this.sources.length + 1,
        url: r.url,
        title: r.title,
        domain: r.domain,
        ...(r.published ? { published: r.published } : {}),
        ...(snippetOf(r.text) ? { snippet: snippetOf(r.text) } : {}),
        ...(read.fresh ? { live: true } : {}),
      };
      this.sources.push(source);
      this.byId.set(r.id, source);
      return r.id;
    });
  }

  /** The sources an answer should keep: those found this turn, and earlier ones it cites. */
  sourcesFor(...texts: string[]): Source[] {
    const cited = new Set(texts.join(" ").match(/S\d[0-9a-f]*/g) ?? []);
    return this.sources.filter((s) => this.foundNow.has(s.id) || cited.has(s.id));
  }
}

/** The first readable stretch of a passage: markdown, headings and link syntax stripped, ~240 chars. */
function snippetOf(excerpt: string): string {
  const text = excerpt
    .split("\n…\n")[0]
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 240 ? `${text.slice(0, 237).replace(/\s+\S*$/, "")}…` : text;
}
