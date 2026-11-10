/**
 * Web search, in two halves on either side of the MCP boundary.
 *
 *   SearchService   the operation: a query in, results out, through the `SearchProvider` port,
 *                   with a short cache and a timeout. It owns the tool's contract (name,
 *                   description, input schema), and the MCP interface (`api/mcp.ts`) serves it
 *   CitedSearch     wraps whatever tool surface the runtime has, for one answer: it numbers the
 *                   results so the answer can cite them ([S1], [S2]...), formats them for the
 *                   model, and reports each search to the screen as it starts and lands
 *
 * Numbering is per answer, so S3 means the same page everywhere in the reply that cites it and
 * nothing outside it. That is why it lives here, per turn, and not in the stateless service.
 */
import { z } from "zod";
import type { ToolCall, ToolResult } from "../agents/conversation.ts";
import type { ToolSpec, ToolSurface } from "../agents/ports.ts";
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

/** How the service hands results across the boundary: plain JSON, so any client can read it. */
export interface SearchPayload {
  results: SearchHit[];
}

export class CitedSearch implements ToolSurface {
  readonly sources: Source[] = [];
  /** The exact text each source showed the model: what its quotes are checked against. */
  readonly snapshots = new Map<string, string>();
  private readonly byUrl = new Map<string, Source>();

  constructor(
    private readonly inner: ToolSurface,
    private readonly report: (activity: Activity, sources: Source[]) => void,
  ) {}

  offered(): ToolSpec[] | Promise<ToolSpec[]> {
    return this.inner.offered();
  }

  async run(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    if (call.name !== SEARCH_TOOL.name) return this.inner.run(call, signal);
    const args = call.arguments as Partial<SearchInput>;
    const activity: Activity = {
      kind: "search", id: call.id, query: String(args.query ?? ""), since: args.since, domains: args.domains, fresh: args.fresh,
    };
    this.report(activity, this.sources);

    let result: ToolResult;
    try {
      result = await this.inner.run(call, signal);
    } catch (error) {
      result = { callId: call.id, name: call.name, content: `Search failed: ${(error as Error).message}`, failed: true };
    }
    if (result.failed) {
      this.report({ ...activity, failed: result.content.replace(/^Search failed:\s*/, "").slice(0, 200) }, this.sources);
      return result;
    }

    let hits: SearchHit[];
    try {
      hits = (JSON.parse(result.content) as SearchPayload).results;
    } catch {
      // A server that answered in prose: pass it through unnumbered rather than lose it.
      this.report({ ...activity, results: 0 }, this.sources);
      return result;
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
        ...result,
        content: args.since
          ? `No results published since ${args.since}. That can mean nothing was announced, or that the pages carry no date; try without \`since\`.`
          : "No results. Try different words.",
      };
    }
    return {
      ...result,
      content: numbered
        .map(({ hit, source }) =>
          [`[${source.id}] ${hit.title} — ${source.domain}${hit.published ? ` — published ${hit.published}` : ""}`, hit.url, hit.excerpt.trim()].join("\n"),
        )
        .join("\n\n"),
    };
  }

  /** The same page found by two searches keeps one number. */
  private number(hit: SearchHit, args: Partial<SearchInput>): Source {
    const domain = domainOf(hit.url);
    const live = args.fresh === true;
    const firstParty = !!args.domains?.some((d) => domain === d.replace(/^www\./, "") || domain.endsWith(`.${d.replace(/^www\./, "")}`));
    const known = this.byUrl.get(hit.url);
    if (known) {
      // Seen before from the cache or a general search; a later live or site-limited read upgrades it.
      if (live) known.live = true;
      if (firstParty) known.firstParty = true;
      return known;
    }
    const source: Source = {
      id: `S${this.sources.length + 1}`,
      url: hit.url,
      title: hit.title,
      domain: domainOf(hit.url),
      ...(hit.published ? { published: hit.published } : {}),
      ...(snippetOf(hit.excerpt) ? { snippet: snippetOf(hit.excerpt) } : {}),
      ...(live ? { live } : {}),
      ...(firstParty ? { firstParty } : {}),
    };
    this.sources.push(source);
    this.byUrl.set(hit.url, source);
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
