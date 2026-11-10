/**
 * The runs in progress, by id. The runtime sends a run's id with every tool call; this is how the
 * MCP interface finds that run's searches (its numbering, its snapshots, its read-aheads) without
 * the runtime knowing any of it exists.
 */
import type { CitedSearch } from "./web-search.ts";

export class RunRegistry {
  private readonly runs = new Map<string, CitedSearch>();

  open(runId: string, search: CitedSearch) {
    this.runs.set(runId, search);
  }
  get(runId: string): CitedSearch | undefined {
    return this.runs.get(runId);
  }
  close(runId: string) {
    this.runs.delete(runId);
  }
}
