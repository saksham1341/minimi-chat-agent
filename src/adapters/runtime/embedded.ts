/** The runtime in this process: the same boundary, crossed by a function call instead of a socket. */
import type { AgentRuntime, RunRequest } from "../../agents/runtime.ts";
import type { AgentRuntimePort } from "../../ports/runtime.ts";

export class EmbeddedRuntime implements AgentRuntimePort {
  constructor(private readonly runtime: AgentRuntime) {}
  async models() {
    return this.runtime.models();
  }
  async say(runId: string, text: string) {
    return this.runtime.say(runId, text);
  }
  run(request: RunRequest, signal?: AbortSignal) {
    // Through JSON, as it would cross a socket: nothing that only works in-process slips across.
    return this.runtime.run(JSON.parse(JSON.stringify(request)) as RunRequest, signal);
  }
}
