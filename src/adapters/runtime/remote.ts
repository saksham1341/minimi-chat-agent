/** The runtime as its own deployment (`npm run agents`), reached over HTTP at AGENT_RUNTIME_URL. */
import type { ModelList, RunEvent, RunRequest } from "../../agents/runtime.ts";
import type { AgentRuntimePort } from "../../ports/runtime.ts";

export class RemoteRuntime implements AgentRuntimePort {
  constructor(private readonly url: string, private readonly token?: string) {}

  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) };
  }

  async models(): Promise<ModelList> {
    const response = await fetch(new URL("/models", this.url), { headers: this.headers() });
    if (!response.ok) throw new Error(`The agent runtime answered ${response.status}.`);
    return (await response.json()) as ModelList;
  }

  async say(runId: string, text: string): Promise<{ id: string } | null> {
    const response = await fetch(new URL(`/runs/${encodeURIComponent(runId)}/input`, this.url), { method: "POST", headers: this.headers(), body: JSON.stringify({ text }) });
    if (response.status === 409) return null;
    if (!response.ok) throw new Error(`The agent runtime answered ${response.status}.`);
    return (await response.json()) as { id: string };
  }

  async *run(request: RunRequest, signal?: AbortSignal): AsyncIterable<RunEvent> {
    const response = await fetch(new URL("/runs", this.url), { method: "POST", headers: this.headers(), body: JSON.stringify(request), signal });
    if (!response.ok || !response.body) throw new Error(`The agent runtime answered ${response.status}.`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6)) as RunEvent;
      }
    }
  }
}
