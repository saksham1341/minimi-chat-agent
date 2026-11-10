/**
 * What the loop asks for, said as shapes rather than as vendors.
 *
 * Ported from Keel's `keel/agents/ports.py`. Two ports: a model that can be given a
 * conversation and some tools and will say something back, and a tool surface that can list
 * what it offers and run one. A second provider is a second adapter; the loop never learns
 * its name.
 */
import type { Entry, Said, ToolCall, ToolResult } from "./conversation.ts";

export interface ToolSpec {
  name: string;
  /** The contract. It is what the model reads to decide whether this is the tool it wants. */
  description: string;
  inputSchema: Record<string, unknown>;
  /** Large inputs (answer shapes) stream as they are written so the UI can draw them live. */
  streamsInput?: boolean;
}

/** What a model emits while it is still talking, for the UI. Turns are the unit of record. */
export type ModelDelta =
  | { type: "text"; text: string }
  /** The model's reasoning as it streams, when the provider shows it. Shown as working, never kept as the answer. */
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_input"; id: string; name: string; partial: unknown };

export interface ModelRequest {
  instruction: string;
  history: Entry[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface ChatModel {
  readonly info: ModelInfo;
  /** One turn. The whole vendor boundary. Caching, reasoning and retries live in the adapter. */
  respond(request: ModelRequest, onDelta?: (delta: ModelDelta) => void): Promise<Said>;
}

export interface ModelInfo {
  /** Stable id the UI sends back, e.g. `anthropic:claude-opus-5-5`. */
  id: string;
  provider: string;
  label: string;
  /** One line under the label in the picker. */
  hint: string;
}

export interface ToolSurface {
  /** What it offers. May ask a remote server, so it may be a promise. */
  offered(): ToolSpec[] | Promise<ToolSpec[]>;
  run(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
}
