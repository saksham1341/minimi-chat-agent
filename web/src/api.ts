/** The server's interface, typed from the server's own types (type-only imports, erased at build). */
import type { ModelInfo } from "../../src/agents/ports.ts";
import type { Activity, Conversation, Source, TurnRecord } from "../../src/domain/memory.ts";
import type { TurnEvent } from "../../src/services/chat.ts";
import type { MemoryPreview } from "../../src/services/recall.ts";

export type { Activity, Conversation, MemoryPreview, ModelInfo, Source, TurnEvent, TurnRecord };

export interface Meta {
  models: ModelInfo[];
  defaultModel: string | null;
  search: { provider: string; available: boolean };
  now: string;
  timeZone: string;
}

export const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json() as Promise<T>;
}

export const api = {
  meta: () => get<Meta>("/api/meta"),
  conversations: () => get<Conversation[]>("/api/conversations"),
  conversation: (id: string) => get<{ conversation: Conversation; turns: TurnRecord[] }>(`/api/conversations/${id}`),

  /** What memory the draft matches, as the person types. Memory only: free, nothing stored. */
  async recall(message: string, conversationId: string | null, signal: AbortSignal): Promise<MemoryPreview[]> {
    const q = new URLSearchParams({ message, timeZone, ...(conversationId ? { conversationId } : {}) });
    const response = await fetch(`/api/recall?${q}`, { signal });
    return response.ok ? response.json() : [];
  },

  /** Streams one turn's events. Aborting the signal stops the agent on the server too. */
  async chat(
    body: { conversationId?: string; message: string; modelId?: string },
    onEvent: (event: TurnEvent) => void,
    signal: AbortSignal,
  ) {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, timeZone }),
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`The server answered ${response.status}.`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (frame.startsWith("data: ")) onEvent(JSON.parse(frame.slice(6)) as TurnEvent);
      }
    }
  },
};
