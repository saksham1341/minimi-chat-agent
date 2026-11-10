/**
 * Exa. Chosen as the default because one call returns both results and the page text the model
 * needs to answer from, it filters by published date (the "since Monday" questions), and it can
 * re-read a page live instead of from cache (`maxAgeHours: 0`), which matters for pricing pages:
 * they change in place and rarely carry a date.
 */
import type { PageRead, SearchHit, SearchProvider, SearchQuery } from "../../ports/search.ts";

export class ExaSearch implements SearchProvider {
  readonly name = "Exa";
  readonly available = true;

  constructor(private readonly apiKey: string) {}

  async read(urls: string[], signal?: AbortSignal): Promise<PageRead[]> {
    const response = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      signal,
      // Live, not from Exa's cache: the point is what the page says now.
      body: JSON.stringify({ urls, text: { maxCharacters: 20000 }, maxAgeHours: 0, livecrawlTimeout: 8000 }),
    });
    if (!response.ok) throw new Error(`Exa answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = (await response.json()) as { results?: { url: string; title?: string; text?: string }[] };
    const byUrl = new Map((body.results ?? []).map((r) => [r.url, r]));
    return urls.map((url) => ({ url, title: byUrl.get(url)?.title?.trim() || url, text: byUrl.get(url)?.text }));
  }

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
        ...(q.domains?.length ? { includeDomains: q.domains } : {}),
        // Passages, not pages: what the model reads is what it answers from, and every character
        // of it is time before the first word. A general search wants breadth, so a few ranked
        // passages per page and its opening. A targeted read (one site, or live) is reading a page
        // for its facts, and pricing tables come through badly as sentences, so it keeps more.
        contents: {
          highlights: { query: q.query, numSentences: targeted(q) ? 4 : 3, highlightsPerUrl: targeted(q) ? 6 : 3 },
          text: { maxCharacters: targeted(q) ? 3000 : 300 },
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
      excerpt: [...(r.highlights ?? []), r.text ?? ""].filter(Boolean).join("\n…\n").slice(0, targeted(q) ? 5000 : 1200),
    }));
  }
}

const targeted = (q: SearchQuery) => !!(q.domains?.length || q.fresh);
