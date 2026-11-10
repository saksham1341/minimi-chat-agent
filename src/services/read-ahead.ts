/**
 * Reads started before the model asks, handed over when it does.
 *
 * The plan comes from the facts memory brought back (`domain/recheck.ts`). The reads go straight to
 * the search service, in the background, the moment recall finishes; nothing waits on them. When
 * the model's search names a planned vendor and wants the same kind of read (the live page, or
 * news since a date), it is answered from the read already in flight. Unclaimed reads are simply
 * never used.
 */
import type { PlannedRead } from "../domain/recheck.ts";
import type { Activity } from "../domain/memory.ts";
import type { SearchHit } from "../ports/search.ts";
import type { SearchInput, SearchService } from "./web-search.ts";

interface Pending {
  read: PlannedRead;
  hits: Promise<SearchHit[]>;
}

export class ReadAhead {
  private readonly pending: Pending[] = [];

  constructor(
    private readonly search: SearchService,
    private readonly report: (activity: Activity) => void,
  ) {}

  start(plan: PlannedRead[], signal?: AbortSignal) {
    plan.forEach((read, i) => {
      const { vendor: _v, kind: _k, ...args } = read;
      const lane: Activity = { kind: "search", id: `ahead-${i}`, query: read.query, since: read.since, domains: read.domains, fresh: read.fresh, ahead: true };
      this.report(lane);
      const hits = this.search.search(args, signal);
      hits.then(
        (found) => this.report({ ...lane, results: found.length }),
        (error) => this.report({ ...lane, failed: (error as Error).message.slice(0, 120) }),
      );
      this.pending.push({ read, hits });
    });
  }

  /** The read this search is asking for, if one is already under way. */
  take(args: Partial<SearchInput>): Promise<SearchHit[]> | undefined {
    const text = `${args.query ?? ""} ${(args.domains ?? []).join(" ")}`.toLowerCase();
    const kind = args.since ? "news" : args.fresh || args.domains?.length ? "page" : undefined;
    if (!kind) return undefined;
    return this.pending.find((p) => p.read.kind === kind && mentions(text, p.read.vendor))?.hits;
  }
}

/** Does the search name the vendor? "Pipedrive pricing" names "Pipedrive"; "HubSpot" names "HubSpot Sales Hub". */
function mentions(text: string, vendor: string): boolean {
  const first = vendor.toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length >= 3);
  return !!first && text.includes(first);
}
