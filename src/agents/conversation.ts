/**
 * What a conversation is made of, said without naming a vendor.
 *
 * Ported from Keel's `keel/agents/conversation.py`. Three kinds of entry and nothing else:
 * somebody asked, the model said something (possibly asking for tools), the tools ran.
 * Every adapter translates to and from these, so the loop, the store and the UI never learn
 * what a provider's wire format looks like.
 */

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  /** A tool that failed still answers. The model asked and is owed a reply. */
  failed: boolean;
  /** The tool's structured result, when it gives one: passed through untouched, for the caller. */
  data?: unknown;
}

/** A person (or the runtime correcting the model) said something. */
export interface Asked {
  kind: "asked";
  by: "user" | "runtime";
  text: string;
  /**
   * What the harness knew when this was asked: the clock, the time references it resolved and
   * what it recalled from earlier conversations. Kept on the entry rather than rebuilt on every
   * request, so the history stays append-only and the provider's prompt cache keeps hitting.
   */
  context?: string;
}

/** The model took a turn. */
export interface Said {
  kind: "said";
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  /**
   * The provider's own blocks for this turn, kept so they can be replayed unchanged (reasoning
   * blocks must be). Tagged with the provider so a different adapter ignores it and rebuilds
   * from the neutral fields above, which is what makes switching model mid-conversation safe.
   */
  vendor?: { provider: string; content: unknown };
}

/** Every result of one round, together. Splitting them teaches the model not to call in parallel. */
export interface Ran {
  kind: "ran";
  results: ToolResult[];
}

export type Entry = Asked | Said | Ran;

export const asked = (text: string, context?: string, by: Asked["by"] = "user"): Asked => ({
  kind: "asked",
  by,
  text,
  ...(context ? { context } : {}),
});
