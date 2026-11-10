/**
 * Web search as a service: a query in, results out, through the `SearchProvider` port, with a
 * short cache and a timeout. It owns the tool's contract (name, description, input schema), and
 * the MCP interface (`api/mcp.ts`) serves it to any agent.
 *
 * It knows nothing of conversations, runs or answers. Each page gets an id from its URL, so the
 * same page is the same id for every caller and every search. Numbering for the screen, snapshots
 * for checking quotes, and what the canvas shows belong to the chat service, which reads them off
 * the run it drives (`services/sources.ts`).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SearchHit, SearchProvider, SearchQuery } from "../ports/search.ts";

export const SEARCH_TOOL = {
  name: "web_search",
  description:
    "Search the web. Returns results with an id each ([S3f2a1]), title, URL, published date when known, and the " +
    "text of the page; the ids are what you cite, and a page keeps its id across searches. Several calls in one " +
    "turn run in parallel.\n\n" +
    "`since` keeps only pages published on or after a day. Use it for news, announcements and changelogs since an " +
    "earlier date. Do not use it to find current prices: pricing pages change in place and rarely carry a date, so " +
    "`since` hides them. For a current price, search the vendor's pricing page with `domains` and `fresh: true`.\n\n" +
    "`fresh` re-reads pages now instead of from the search provider's cache. It is slower; use it only when the " +
    "exact current state of a page matters.",
  input: z.object({
    query: z.string().min(1).describe("What to search for, as you would type it into a search engine."),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only pages published on or after this day, YYYY-MM-DD."),
    domains: z.array(z.string()).max(10).optional().describe("Only these sites, e.g. ['neon.tech']."),
    fresh: z.boolean().optional().describe("Re-read the pages live. Slower."),
    max_results: z.number().int().min(1).max(10).optional().describe("Default 5."),
  }),
};
export type SearchInput = z.infer<typeof SEARCH_TOOL.input>;

/**
 * Results for the same query within a few minutes are the same results; asking twice is waste.
 * A search still in flight is shared, so a second ask waits for the first instead of repeating it.
 * A live read (`fresh`) is reused only while it is very recent: it was asked for to be current.
 */
export class SearchCache {
  private readonly entries = new Map<string, { at: number; hits: Promise<SearchHit[]> }>();
  constructor(private readonly ttlMs = 10 * 60_000, private readonly freshMs = 2 * 60_000, private readonly size = 200) {}

  async through(query: SearchQuery, run: () => Promise<SearchHit[]>): Promise<{ hits: SearchHit[]; cached: boolean }> {
    const key = JSON.stringify(query);
    const entry = this.entries.get(key);
    if (entry && Date.now() - entry.at < (query.fresh ? this.freshMs : this.ttlMs)) {
      const hits = await entry.hits.catch(() => undefined);
      if (hits) return { hits, cached: true };
    }
    const hits = run();
    this.entries.set(key, { at: Date.now(), hits });
    hits.catch(() => this.entries.delete(key));
    if (this.entries.size > this.size) this.entries.delete(this.entries.keys().next().value!);
    return { hits: await hits, cached: false };
  }
}

/** A result as the search service hands it over: the same for every caller. */
export interface SearchResult {
  /** Derived from the URL, so the same page has the same id in every search, for every caller. */
  id: string;
  title: string;
  url: string;
  domain: string;
  published?: string;
  text: string;
}

export class SearchService {
  constructor(
    private readonly provider: SearchProvider,
    private readonly cache = new SearchCache(),
    private readonly timeoutMs = 20_000,
  ) {}

  get available() {
    return this.provider.available;
  }
  get providerName() {
    return this.provider.name;
  }

  async search(input: SearchInput, signal?: AbortSignal): Promise<{ results: SearchResult[]; cached: boolean }> {
    const query: SearchQuery = { query: input.query, since: input.since, domains: input.domains, fresh: input.fresh, maxResults: input.max_results ?? 5 };
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      const { hits, cached } = await this.cache.through(query, () => this.provider.search(query, signal ? AbortSignal.any([signal, timeout]) : timeout));
      return { cached, results: hits.map((h) => ({ id: sourceId(h.url), title: h.title, url: h.url, domain: domainOf(h.url), ...(h.published ? { published: h.published } : {}), text: h.excerpt })) };
    } catch (error) {
      throw timeout.aborted ? new Error(`timed out after ${this.timeoutMs / 1000}s`) : error;
    }
  }

  /** Read exact pages now, live, as results with their stable ids. Unreadable pages come back without text. */
  async read(urls: string[], signal?: AbortSignal): Promise<(SearchResult & { readable: boolean })[]> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const pages = await this.provider.read(urls, signal ? AbortSignal.any([signal, timeout]) : timeout);
    return pages.map((p) => ({ id: sourceId(p.url), title: p.title, url: p.url, domain: domainOf(p.url), text: p.text ?? "", readable: !!p.text }));
  }
}

/** Results as the model reads them: id, title, site, date, address, then the page's text. */
export function formatResults(results: SearchResult[], since?: string): string {
  if (!results.length) {
    return since
      ? `No results published since ${since}. That can mean nothing was announced, or that the pages carry no date; try without \`since\`.`
      : "No results. Try different words.";
  }
  return results
    .map((r) => [`[${r.id}] ${r.title} — ${r.domain}${r.published ? ` — published ${r.published}` : ""}`, r.url, r.text.trim()].join("\n"))
    .join("\n\n");
}

/**
 * A short id for a page, the same wherever it turns up: "S", a digit, and four hex characters
 * (S3f2a1), so it cannot be mistaken for a bracketed word.
 */
export function sourceId(url: string): string {
  const hash = createHash("sha1").update(url).digest("hex");
  return `S${parseInt(hash[0], 16) % 10}${hash.slice(1, 5)}`;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
