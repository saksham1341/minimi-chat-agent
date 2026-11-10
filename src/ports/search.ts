/** Web search, as the agent needs it. A provider is an adapter; the tool surface never names one. */

export interface SearchQuery {
  query: string;
  /** Only pages published on or after this day (YYYY-MM-DD). */
  since?: string;
  until?: string;
  domains?: string[];
  maxResults: number;
  /** Re-read pages now instead of from the provider's cache (current prices, status pages). */
  fresh?: boolean;
}

export interface SearchHit {
  title: string;
  url: string;
  published?: string; // YYYY-MM-DD when the provider knows it
  excerpt: string;
}

export interface SearchProvider {
  readonly name: string;
  /** False for the absent adapter, so the UI can say search is off rather than fail later. */
  readonly available: boolean;
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]>;
}
