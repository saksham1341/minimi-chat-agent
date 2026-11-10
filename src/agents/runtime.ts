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
import { Inbox } from "./inbox.ts";
import { stream, type LoopEvent, type OutputShape } from "./loop.ts";
import { McpToolSurface } from "./mcp.ts";
import type { ChatModel, ModelInfo, ToolSurface } from "./ports.ts";

export interface RunRequest {
  /** For the caller's own bookkeeping and logs; the runtime keeps nothing by it. */
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

/** Messages a run will hold before refusing more. */
const MAX_WAITING = 32;

export class AgentRuntime {
  private readonly byId: Map<string, ChatModel>;
  /** The inbox of every run in progress, by the caller's run id. */
  private readonly inboxes = new Map<string, Inbox>();

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
    const tools = request.tools === false || !this.toolServer ? undefined : new McpToolSurface(this.toolServer);
    const inbox = new Inbox();
    this.inboxes.set(request.runId, inbox);
    try {
      yield* stream(model, tools ?? NO_TOOLS, {
        instruction: request.instruction,
        ask: request.ask,
        history: request.history,
        endings: request.endings,
        maxRounds: request.maxRounds,
        signal,
        inbox,
      });
    } finally {
      // Whatever is still waiting when the run ends was never heard: the caller sends it as a new ask.
      this.inboxes.delete(request.runId);
      await tools?.close();
    }
  }

  /**
   * Say something to a run that is still working. Taken up at its next seam; the run streams
   * `dequeued` when it is. Null when there is no such run (it has finished) or it is full.
   */
  say(runId: string, text: string): { id: string } | null {
    const inbox = this.inboxes.get(runId);
    if (!inbox || inbox.size >= MAX_WAITING) return null;
    return { id: inbox.put(text).id };
  }

  private defaultId(): string | undefined {
    const match = this.preferred && [...this.byId.keys()].find((id) => id === this.preferred || id.endsWith(`:${this.preferred}`));
    return match || this.byId.keys().next().value;
  }
}
