/**
 * The agent's one tool. A service over the `SearchProvider` port: it turns the model's call into
 * a query, numbers what comes back so the answer can cite it ([S1], [S2]...), keeps a short cache,
 * and reports each search to the screen as it starts and finishes.
 *
 * One instance per turn, because the numbering is per answer: S3 means the same page everywhere
 * in the reply that cites it, and nothing outside it.
 */
import { z } from "zod";
import type { ToolCall, ToolResult } from "../agents/conversation.ts";
import type { ToolSpec, ToolSurface } from "../agents/ports.ts";
import type { Activity, Source } from "../domain/memory.ts";
import type { SearchHit, SearchProvider, SearchQuery } from "../ports/search.ts";

const Input = z.object({
  query: z.string().min(1),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  domains: z.array(z.string()).max(10).optional(),
  fresh: z.boolean().optional(),
  max_results: z.number().int().min(1).max(10).optional(),
});

export const WEB_SEARCH: ToolSpec = {
  name: "web_search",
  description:
    "Search the web. Returns numbered results ([S1], [S2]...) with title, URL, published date when known, and the " +
    "passages that match. Cite them by id in your answer. Make several calls in the same turn to cover several " +
    "entities or angles at once; they run in parallel.\n\n" +
    "`since` keeps only pages published on or after a day. Use it for news, announcements and changelogs since an " +
    "earlier date. Do not use it to find current prices: pricing pages change in place and rarely carry a date, so " +
    "`since` hides them. For a current price, search the vendor's pricing page with `domains` and `fresh: true`.\n\n" +
    "`fresh` re-reads pages now instead of from the search provider's cache. It is slower; use it only when the " +
    "exact current state of a page matters.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for, as you would type it into a search engine." },
      since: { type: "string", description: "Only pages published on or after this day, YYYY-MM-DD." },
      domains: { type: "array", items: { type: "string" }, description: "Only these sites, e.g. ['neon.tech']." },
      fresh: { type: "boolean", description: "Re-read the pages live. Slower." },
      max_results: { type: "integer", minimum: 1, maximum: 10, description: "Default 6." },
    },
    required: ["query"],
  },
};

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

export class WebSearchTool implements ToolSurface {
  readonly sources: Source[] = [];
  private readonly byUrl = new Map<string, Source>();

  constructor(
    private readonly provider: SearchProvider,
    private readonly cache: SearchCache,
    private readonly report: (activity: Activity, sources: Source[]) => void,
    private readonly timeoutMs = 20_000,
  ) {}

  offered(): ToolSpec[] {
    return [WEB_SEARCH];
  }

  async run(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const fail = (content: string): ToolResult => ({ callId: call.id, name: call.name, content, failed: true });
    if (call.name !== WEB_SEARCH.name) return fail(`There is no tool called ${call.name}.`);
    const parsed = Input.safeParse(call.arguments);
    if (!parsed.success) return fail(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);

    const input = parsed.data;
    const query: SearchQuery = {
      query: input.query,
      since: input.since,
      domains: input.domains,
      fresh: input.fresh,
      maxResults: input.max_results ?? 6,
    };
    const activity: Activity = { kind: "search", id: call.id, query: input.query, since: input.since, domains: input.domains };
    this.report(activity, this.sources);

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let hits: SearchHit[];
    try {
      hits = await this.cache.through(query, () => this.provider.search(query, combined));
    } catch (error) {
      const message = timeout.aborted ? `timed out after ${this.timeoutMs / 1000}s` : (error as Error).message;
      this.report({ ...activity, failed: message }, this.sources);
      return fail(`Search failed: ${message}`);
    }

    const numbered = hits.map((hit) => ({ hit, source: this.number(hit) }));
    this.report({ ...activity, results: hits.length }, this.sources);

    if (!numbered.length) {
      return {
        callId: call.id,
        name: call.name,
        failed: false,
        content: input.since
          ? `No results published since ${input.since}. That can mean nothing was announced, or that the pages carry no date; try without \`since\`.`
          : "No results. Try different words.",
      };
    }
    return {
      callId: call.id,
      name: call.name,
      failed: false,
      content: numbered
        .map(({ hit, source }) =>
          [`[${source.id}] ${hit.title} — ${source.domain}${hit.published ? ` — published ${hit.published}` : ""}`, hit.url, hit.excerpt.trim()].join("\n"),
        )
        .join("\n\n"),
    };
  }

  /** The same page found by two searches keeps one number. */
  private number(hit: SearchHit): Source {
    const known = this.byUrl.get(hit.url);
    if (known) return known;
    const source: Source = {
      id: `S${this.sources.length + 1}`,
      url: hit.url,
      title: hit.title,
      domain: domainOf(hit.url),
      ...(hit.published ? { published: hit.published } : {}),
    };
    this.sources.push(source);
    this.byUrl.set(hit.url, source);
    return source;
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
