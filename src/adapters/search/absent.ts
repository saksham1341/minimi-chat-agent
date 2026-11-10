/**
 * No search key configured. Keel's rule: absence is an implementation with a name. It refuses
 * honestly, every time, instead of the code branching on a missing provider everywhere.
 */
import type { SearchHit, SearchProvider } from "../../ports/search.ts";

export class AbsentSearch implements SearchProvider {
  readonly name = "none";
  readonly available = false;

  async search(): Promise<SearchHit[]> {
    throw new Error("Web search is not configured on this server (set EXA_API_KEY or TAVILY_API_KEY). Answer from what you know and say it is unverified.");
  }
}
