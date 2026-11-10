/**
 * Searches started before the model asks, offered to it rather than slipped in.
 *
 * The plan comes from the facts memory brought back (`domain/recheck.ts`). The searches start in
 * the background the moment recall finishes, through the search service, which keeps them (in
 * flight or done) in its cache. The model is told exactly which searches are ready; if it runs one,
 * the cache answers at once. Nothing is substituted for a search the model did not ask for, and a
 * search it does not run is simply never used.
 */
import type { PlannedRead } from "../domain/recheck.ts";
import type { Activity } from "../domain/memory.ts";
import type { SearchInput, SearchService } from "./web-search.ts";

export function readAhead(search: SearchService, plan: PlannedRead[], report: (activity: Activity) => void): string {
  if (!plan.length) return "";
  const calls: SearchInput[] = plan.map(({ query, domains, fresh, since }) => ({ query, ...(domains ? { domains } : {}), ...(fresh ? { fresh } : {}), ...(since ? { since } : {}) }));
  calls.forEach((args, i) => {
    const lane: Activity = { kind: "search", id: `ahead-${i}`, query: args.query, since: args.since, domains: args.domains, fresh: args.fresh, ahead: true };
    report(lane);
    search.warm(args).then(
      (results) => report({ ...lane, results: results.length }),
      (error) => report({ ...lane, failed: (error as Error).message.slice(0, 120) }),
    );
  });
  return (
    `\n\n<prepared written-by="system">\nThese searches were started in case this message is about re-checking an earlier answer. ` +
    `If it is, call web_search with exactly these arguments and the results come back at once; if not, ignore them.\n` +
    calls.map((args) => `- ${JSON.stringify(args)}`).join("\n") +
    `\n</prepared>`
  );
}
