/** Tavily, the second adapter: same port, a different vendor, for whoever has that key instead. */
import type { SearchHit, SearchProvider, SearchQuery } from "../../ports/search.ts";

export class TavilySearch implements SearchProvider {
  readonly name = "Tavily";
  readonly available = true;

  constructor(private readonly apiKey: string) {}

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]> {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        query: q.query,
        search_depth: "advanced",
        chunks_per_source: 3,
        max_results: q.maxResults,
        include_published_date: true,
        ...(q.since ? { start_date: q.since } : {}),
        ...(q.until ? { end_date: q.until } : {}),
        ...(q.domains?.length ? { include_domains: q.domains } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Tavily answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = (await response.json()) as { results?: { title?: string; url: string; content?: string; published_date?: string }[] };
    return (body.results ?? []).map((r) => ({
      title: r.title?.trim() || r.url,
      url: r.url,
      published: r.published_date ? new Date(r.published_date).toISOString().slice(0, 10) : undefined,
      excerpt: (r.content ?? "").slice(0, 1500),
    }));
  }
}
