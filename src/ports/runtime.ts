import type { ModelList, RunEvent, RunRequest } from "../agents/runtime.ts";

/**
 * The agent runtime, as the application sees it: something that lists its models and runs a turn.
 * In this process or another one; the application does not know which (`APP_AGENTS`).
 */
export interface AgentRuntimePort {
  models(): Promise<ModelList>;
  run(request: RunRequest, signal?: AbortSignal): AsyncIterable<RunEvent>;
}
