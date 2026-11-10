/**
 * What every door to Claude shares: the Messages wire format. The direct API and Bedrock take the
 * same messages, the same tool shapes and stream the same events, so translation lives here once
 * and each adapter holds only what its door changes (auth, model names, how to ask for thinking).
 *
 * Typed loosely on purpose: the two doors are served by different SDK majors (Bedrock's pre-4.7
 * models need the older one), and the JSON is identical even where the TypeScript types are not.
 */
import { parse as parsePartial, Allow } from "partial-json";
import type { Entry, Said, ToolCall } from "../conversation.ts";
import type { ModelDelta, ToolSpec } from "../ports.ts";

type Block = Record<string, unknown>;
export interface WireMessage {
  role: "user" | "assistant";
  content: Block[];
}

/**
 * Neutral entries to Claude messages. Blocks this provider wrote are replayed unchanged (thinking
 * blocks must be); turns another provider wrote are rebuilt from the neutral fields.
 */
export function toWire(history: Entry[], provider: string, options: { cacheLast?: boolean } = {}): WireMessage[] {
  const messages: WireMessage[] = [];
  const push = (role: WireMessage["role"], content: Block[]) => {
    const last = messages.at(-1);
    if (last && last.role === role) last.content.push(...content);
    else messages.push({ role, content: [...content] });
  };

  for (const entry of history) {
    if (entry.kind === "asked") {
      const blocks: Block[] = [];
      if (entry.context) blocks.push({ type: "text", text: entry.context });
      blocks.push({ type: "text", text: entry.by === "runtime" ? `<runtime>${entry.text}</runtime>` : entry.text });
      push("user", blocks);
    } else if (entry.kind === "said") {
      if (entry.vendor?.provider === provider) {
        push("assistant", entry.vendor.content as Block[]);
        continue;
      }
      const blocks: Block[] = [];
      if (entry.text) blocks.push({ type: "text", text: entry.text });
      for (const call of entry.toolCalls) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      push("assistant", blocks.length ? blocks : [{ type: "text", text: "(no reply)" }]);
    } else {
      push(
        "user",
        entry.results.map((result) => ({
          type: "tool_result",
          tool_use_id: result.callId,
          content: result.content,
          ...(result.failed ? { is_error: true } : {}),
        })),
      );
    }
  }

  if (options.cacheLast) {
    // Mark the newest block so the whole conversation prefix is cached for the next request.
    const last = messages.at(-1)?.content.at(-1);
    if (last) messages.at(-1)!.content[messages.at(-1)!.content.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
  }
  return messages;
}

export function toolsToWire(tools: ToolSpec[], eager: boolean) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(eager && tool.streamsInput ? { eager_input_streaming: true } : {}),
  }));
}

interface WireStream {
  [Symbol.asyncIterator](): AsyncIterator<any>;
  finalMessage(): Promise<{ content: any[]; stop_reason: string | null }>;
}

/** Reads one streamed turn: forwards deltas for the screen, then returns the whole turn. */
export async function readTurn(stream: WireStream, provider: string, onDelta?: (delta: ModelDelta) => void): Promise<Said> {
  const tools = new Map<number, { id: string; name: string; json: string }>();
  for await (const event of stream) {
    if (!onDelta) continue;
    if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
      tools.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: "" });
      onDelta({ type: "tool_start", id: event.content_block.id, name: event.content_block.name });
    } else if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") onDelta({ type: "text", text: event.delta.text });
      else if (event.delta.type === "input_json_delta") {
        const tool = tools.get(event.index);
        if (!tool) continue;
        tool.json += event.delta.partial_json;
        try {
          onDelta({ type: "tool_input", id: tool.id, name: tool.name, partial: parsePartial(tool.json, Allow.ALL) });
        } catch {
          // Mid-token; the next fragment will parse.
        }
      }
    }
  }
  const message = await stream.finalMessage();

  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, arguments: (block.input ?? {}) as Record<string, unknown> });
  }

  if (message.stop_reason === "refusal") {
    // Never run a refused turn's tools: a refusal can cut a call off mid-input.
    return { kind: "said", text: text || "I can't help with that one.", toolCalls: [], stopReason: "refusal" };
  }
  if (message.stop_reason === "max_tokens" && toolCalls.length) {
    // A truncated input can still parse as a valid partial object, so it is not run.
    return { kind: "said", text: text || "My answer ran too long and was cut off.", toolCalls: [], stopReason: "max_tokens" };
  }
  return { kind: "said", text, toolCalls, stopReason: message.stop_reason ?? "end_turn", vendor: { provider, content: message.content } };
}

/**
 * Retries only a streamed tool input that could not be parsed at all. The SDKs already retry
 * rate limits, server errors and dropped connections; anything they raise is passed on.
 */
export async function withJsonRetry<T>(once: () => Promise<T>, isApiError: (e: unknown) => boolean, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await once();
    } catch (error) {
      if (isApiError(error) || signal?.aborted || attempt >= 2) throw error;
    }
  }
}
