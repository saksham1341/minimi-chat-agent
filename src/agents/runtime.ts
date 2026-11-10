/**
 * The agent runtime: the loop, the models and their credentials, and an MCP client. Ported from
 * Keel's `keel/agents`, and like it, it knows nothing of the application it serves (not one
 * import). The application asks it to run a turn; it reaches the application's tools only over
 * MCP, at the endpoint it was configured with, and streams back what happens.
 *
 * Embedded or remote is the application's choice (`APP_AGENTS`); the boundary is the same either
 * way. In-process the request is a function call with no socket; remote it is `agents/api.ts`.
 */
import type { Asked, Entry } from "./conversation.ts";
import { stream, type LoopEvent, type OutputShape } from "./loop.ts";
import { McpToolSurface } from "./mcp.ts";
import type { ChatModel, ModelInfo, ToolSurface } from "./ports.ts";

export interface RunRequest {
  /** Sent to the tool server with every call, so it can keep this run's state (citations, say). */
  runId: string;
  model?: string;
  instruction: string;
  history: Entry[];
  ask: Asked;
  /** The shapes an answer may take besides prose: plain data. */
  endings: OutputShape[];
  maxRounds?: number;
  /** False for a run that only writes (an extraction): no tool server is contacted. */
  tools?: boolean;
}

export type RunEvent = LoopEvent | { type: "error"; message: string };

export interface ModelList {
  models: ModelInfo[];
  defaultModel: string | null;
}

const NO_TOOLS: ToolSurface = {
  offered: () => [],
  run: async (call) => ({ callId: call.id, name: call.name, content: "No tools in this run.", failed: true }),
};

export class AgentRuntime {
  private readonly byId: Map<string, ChatModel>;

  constructor(
    models: ChatModel[],
    private readonly toolServer: URL | undefined,
    private readonly preferred?: string,
  ) {
    this.byId = new Map(models.map((m) => [m.info.id, m]));
  }

  models(): ModelList {
    return { models: [...this.byId.values()].map((m) => m.info), defaultModel: this.defaultId() ?? null };
  }

  async *run(request: RunRequest, signal?: AbortSignal): AsyncIterable<RunEvent> {
    const model = (request.model && this.byId.get(request.model)) || this.byId.get(this.defaultId() ?? "");
    if (!model) {
      yield { type: "error", message: "No model is configured on the agent runtime." };
      return;
    }
    const tools = request.tools === false || !this.toolServer ? undefined : new McpToolSurface(this.toolServer, { "x-run-id": request.runId });
    try {
      yield* stream(model, tools ?? NO_TOOLS, {
        instruction: request.instruction,
        ask: request.ask,
        history: request.history,
        endings: request.endings,
        maxRounds: request.maxRounds,
        signal,
      });
    } finally {
      await tools?.close();
    }
  }

  private defaultId(): string | undefined {
    const match = this.preferred && [...this.byId.keys()].find((id) => id === this.preferred || id.endsWith(`:${this.preferred}`));
    return match || this.byId.keys().next().value;
  }
}
