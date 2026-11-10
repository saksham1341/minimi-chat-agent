/**
 * Reads started before the model asks, handed over when it does.
 *
 * The plan comes from the facts memory brought back (`domain/recheck.ts`). The reads run through
 * the runtime's own tool surface, in the background, the moment recall finishes; nothing waits on
 * them. When the model's search names a planned vendor and wants the same kind of read (the live
 * page, or news since a date), it is answered from the read already in flight. Unclaimed reads are
 * simply never used.
 */
import type { ToolResult } from "../agents/conversation.ts";
import type { ToolSurface } from "../agents/ports.ts";
import type { PlannedRead } from "../domain/recheck.ts";
import type { Activity } from "../domain/memory.ts";
import { SEARCH_TOOL, type SearchInput } from "./web-search.ts";

interface Pending {
  read: PlannedRead;
  result: Promise<ToolResult>;
}

export class ReadAhead {
  private readonly pending: Pending[] = [];

  constructor(
    private readonly tools: ToolSurface,
    private readonly report: (activity: Activity) => void,
  ) {}

  start(plan: PlannedRead[], signal?: AbortSignal) {
    plan.forEach((read, i) => {
      const { vendor: _v, kind: _k, ...args } = read;
      const id = `ahead-${i}`;
      const lane: Activity = { kind: "search", id, query: read.query, since: read.since, domains: read.domains, fresh: read.fresh, ahead: true };
      this.report(lane);
      const result = this.tools.run({ id, name: SEARCH_TOOL.name, arguments: args }, signal).then(
        (r) => {
          this.report({ ...lane, ...(r.failed ? { failed: r.content.slice(0, 120) } : { results: count(r.content) }) });
          return r;
        },
        (error) => {
          this.report({ ...lane, failed: (error as Error).message });
          return { callId: id, name: SEARCH_TOOL.name, content: `Search failed: ${(error as Error).message}`, failed: true };
        },
      );
      this.pending.push({ read, result });
    });
  }

  /** The read this search is asking for, if one is already under way. */
  take(args: Partial<SearchInput>): Promise<ToolResult> | undefined {
    const text = `${args.query ?? ""} ${(args.domains ?? []).join(" ")}`.toLowerCase();
    const kind = args.since ? "news" : args.fresh || args.domains?.length ? "page" : undefined;
    if (!kind) return undefined;
    const match = this.pending.find((p) => p.read.kind === kind && mentions(text, p.read.vendor));
    return match?.result.then((r) => (r.failed ? Promise.reject(new Error(r.content)) : r));
  }
}

/** Does the search name the vendor? "Pipedrive pricing" names "Pipedrive"; "HubSpot" names "HubSpot Sales Hub". */
function mentions(text: string, vendor: string): boolean {
  const first = vendor.toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length >= 3);
  return !!first && text.includes(first);
}

function count(content: string): number {
  try {
    return (JSON.parse(content) as { results: unknown[] }).results.length;
  } catch {
    return 0;
  }
}
