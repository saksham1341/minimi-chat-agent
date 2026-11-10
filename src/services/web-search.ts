/**
 * Web search, in two halves on either side of the MCP boundary.
 *
 *   SearchService   the operation: a query in, results out, through the `SearchProvider` port,
 *                   with a short cache and a timeout. It owns the tool's contract (name,
 *                   description, input schema), and the MCP interface (`api/mcp.ts`) serves it
 *   CitedSearch     one run's view of it: numbers the results so the answer can cite them
 *                   ([S1], [S2]...), keeps each source's text, and reports each search to the
 *                   screen. The MCP interface serves it per run (`api/mcp.ts`)
 *
 * Numbering is per answer, so S3 means the same page everywhere in the reply that cites it and
 * nothing outside it. That is why it lives here, per turn, and not in the stateless service.
 */
import { z } from "zod";
import type { Activity, Source } from "../domain/memory.ts";
import type { SearchHit, SearchProvider, SearchQuery } from "../ports/search.ts";

export const SEARCH_TOOL = {
  name: "web_search",
  description:
    "Search the web. Returns numbered results ([S1], [S2]...) with title, URL, published date when known, and the " +
    "text of each page; the numbers are what you cite. Several calls in one turn run in parallel.\n\n" +
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

/** Results for the same query within a few minutes are the same results; asking twice is waste. */
export class SearchCache {
  private readonly entries = new Map<string, { at: number; hits: SearchHit[] }>();
  constructor(private readonly ttlMs = 10 * 60_000, private readonly size = 200) {}

  async through(query: SearchQuery, run: () => Promise<SearchHit[]>): Promise<SearchHit[]> {
    const key = JSON.stringify(query);
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs && !query.fresh) return hit.hits;
    const hits = await run();
    this.entries.set(key, { at: Date.now(), hits });
    if (this.entries.size > this.size) this.entries.delete(this.entries.keys().next().value!);
    return hits;
  }
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

  async search(input: SearchInput, signal?: AbortSignal): Promise<SearchHit[]> {
    const query: SearchQuery = { query: input.query, since: input.since, domains: input.domains, fresh: input.fresh, maxResults: input.max_results ?? 5 };
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      return await this.cache.through(query, () => this.provider.search(query, signal ? AbortSignal.any([signal, timeout]) : timeout));
    } catch (error) {
      throw timeout.aborted ? new Error(`timed out after ${this.timeoutMs / 1000}s`) : error;
    }
  }
}

export interface CitedSearchOptions {
  /** Searches already under way for this turn; a matching search is answered from them. */
  readAhead?: { take(args: Partial<SearchInput>): Promise<SearchHit[]> | undefined };
  /**
   * Sources and snapshots from earlier turns of the same conversation. Numbering carries on from
   * them, so a follow-up can cite S5 from the last answer and have the quote checked.
   */
  prior?: { sources: Source[]; snapshots: ReadonlyMap<string, string> };
}

/**
 * One run's searches, as the model sees them: numbered so an answer can cite them ([S1], [S2]...),
 * each source's text kept as a snapshot its quotes are checked against, and each search reported
 * to the screen as it starts and lands. Lives in the application, behind MCP: the runtime only
 * ever sees the text this returns.
 */
export class CitedSearch {
  /** Every source this conversation knows, earlier turns' first. */
  readonly sources: Source[] = [];
  /** The exact text each source showed the model: what its quotes are checked against. */
  readonly snapshots = new Map<string, string>();
  private readonly byUrl = new Map<string, Source>();
  private readonly foundNow = new Set<string>();
  private next = 1;
  private calls = 0;

  constructor(
    private readonly search: SearchService,
    private readonly report: (activity: Activity, sources: Source[]) => void = () => {},
    private readonly options: CitedSearchOptions = {},
  ) {
    for (const source of options.prior?.sources ?? []) {
      if (this.sources.some((s) => s.id === source.id)) continue;
      this.sources.push(source);
      this.byUrl.set(source.url, source);
      this.next = Math.max(this.next, Number(source.id.slice(1)) + 1);
    }
    for (const [id, text] of options.prior?.snapshots ?? []) this.snapshots.set(id, text);
  }

  /** The sources an answer should keep: those found this turn, and earlier ones it cites. */
  sourcesFor(...texts: string[]): Source[] {
    const cited = new Set(texts.join(" ").match(/S\d+/g) ?? []);
    return this.sources.filter((s) => this.foundNow.has(s.id) || cited.has(s.id));
  }

  /** One search, answered as the text the model reads. */
  async answer(args: SearchInput, signal?: AbortSignal): Promise<{ text: string; failed: boolean }> {
    const activity: Activity = {
      kind: "search", id: `search-${++this.calls}`, query: args.query, since: args.since, domains: args.domains, fresh: args.fresh,
    };
    this.report(activity, this.sources);

    let hits: SearchHit[];
    try {
      const ahead = this.options.readAhead?.take(args);
      hits = ahead ? await ahead.catch(() => this.search.search(args, signal)) : await this.search.search(args, signal);
      if (ahead) activity.reused = true;
    } catch (error) {
      const message = (error as Error).message;
      this.report({ ...activity, failed: message.slice(0, 200) }, this.sources);
      return { text: `Search failed: ${message}`, failed: true };
    }

    const numbered = hits.map((hit) => ({ hit, source: this.number(hit, args) }));
    for (const { hit, source } of numbered) {
      // A page read twice keeps both readings: a quote from either one is a quote from the page.
      const before = this.snapshots.get(source.id);
      this.snapshots.set(source.id, before && !before.includes(hit.excerpt) ? `${before}\n\n${hit.excerpt}` : before ?? hit.excerpt);
    }
    this.report({ ...activity, results: hits.length, hits: numbered.map((n) => n.source.id) }, this.sources);

    if (!numbered.length) {
      return {
        failed: false,
        text: args.since
          ? `No results published since ${args.since}. That can mean nothing was announced, or that the pages carry no date; try without \`since\`.`
          : "No results. Try different words.",
      };
    }
    return {
      failed: false,
      text: numbered
        .map(({ hit, source }) =>
          [`[${source.id}] ${hit.title} — ${source.domain}${hit.published ? ` — published ${hit.published}` : ""}`, hit.url, hit.excerpt.trim()].join("\n"),
        )
        .join("\n\n"),
    };
  }

  /** The same page found by two searches keeps one number. */
  private number(hit: SearchHit, args: Partial<SearchInput>): Source {
    const live = args.fresh === true;
    const known = this.byUrl.get(hit.url);
    if (known) {
      this.foundNow.add(known.id);
      // Seen before from the cache or a general search; a later live read upgrades it.
      if (live) known.live = true;
      return known;
    }
    const source: Source = {
      id: `S${this.next++}`,
      url: hit.url,
      title: hit.title,
      domain: domainOf(hit.url),
      ...(hit.published ? { published: hit.published } : {}),
      ...(snippetOf(hit.excerpt) ? { snippet: snippetOf(hit.excerpt) } : {}),
      ...(live ? { live } : {}),
    };
    this.sources.push(source);
    this.byUrl.set(hit.url, source);
    this.foundNow.add(source.id);
    return source;
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

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
