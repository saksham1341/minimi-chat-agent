/**
 * Exa. Chosen as the default because one call returns both results and the page text the model
 * needs to answer from, it filters by published date (the "since Monday" questions), and it can
 * re-read a page live instead of from cache (`maxAgeHours: 0`), which matters for pricing pages:
 * they change in place and rarely carry a date.
 */
import type { SearchHit, SearchProvider, SearchQuery } from "../../ports/search.ts";

export class ExaSearch implements SearchProvider {
  readonly name = "Exa";
  readonly available = true;

  constructor(private readonly apiKey: string) {}

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]> {
    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        query: q.query,
        type: "auto",
        numResults: q.maxResults,
        ...(q.since ? { startPublishedDate: `${q.since}T00:00:00.000Z` } : {}),
        ...(q.until ? { endPublishedDate: `${q.until}T23:59:59.999Z` } : {}),
        ...(q.domains?.length ? { includeDomains: q.domains } : {}),
        contents: {
          highlights: { query: q.query },
          // A targeted read (one site, or live) is reading a page for its facts: pricing tables need
          // room. A general search wants breadth, so short passages from more pages.
          text: { maxCharacters: q.domains?.length || q.fresh ? 5000 : 800 },
          ...(q.fresh ? { maxAgeHours: 0, livecrawlTimeout: 8000 } : {}),
        },
      }),
    });
    if (!response.ok) throw new Error(`Exa answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = (await response.json()) as {
      results?: { title?: string; url: string; publishedDate?: string; text?: string; highlights?: string[] }[];
    };
    return (body.results ?? []).map((r) => ({
      title: r.title?.trim() || r.url,
      url: r.url,
      published: r.publishedDate?.slice(0, 10),
      // Highlights are the passages that match the query; the opening of the page gives context.
      excerpt: [...(r.highlights ?? []), r.text ?? ""].filter(Boolean).join("\n…\n").slice(0, q.domains?.length || q.fresh ? 6000 : 1500),
    }));
  }
}
