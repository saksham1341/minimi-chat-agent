/**
 * The split, tested at its seams: the runtime reached over HTTP as its own deployment, and the
 * application checking what a run produced and continuing it with a correction.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { asked } from "../src/agents/conversation.ts";
import { runtimeServer } from "../src/agents/api.ts";
import type { ChatModel } from "../src/agents/ports.ts";
import { AgentRuntime, type RunEvent, type RunRequest } from "../src/agents/runtime.ts";
import { SystemClock } from "../src/adapters/clock.ts";
import { RemoteRuntime } from "../src/adapters/runtime/remote.ts";
import { SqliteMemory } from "../src/adapters/store/sqlite.ts";
import type { AgentRuntimePort } from "../src/ports/runtime.ts";
import { ModelCatalog } from "../src/services/catalog.ts";
import { ChatService, type TurnEvent } from "../src/services/chat.ts";
import { Citer, CITE_INSTRUCTION } from "../src/services/citer.ts";
import { Indexer } from "../src/services/indexer.ts";
import { citationsIn } from "../src/domain/quotes.ts";
import { LedgerService } from "../src/services/ledger.ts";
import { RecallService } from "../src/services/recall.ts";
import { SearchService } from "../src/services/web-search.ts";

const model = (reply: string): ChatModel => ({
  info: { id: "fake:model", provider: "fake", label: "Fake", hint: "" },
  respond: async () => ({ kind: "said", text: reply, toolCalls: [], stopReason: "end_turn" }),
});

describe("the runtime as its own deployment", () => {
  it("lists its models and runs a turn over HTTP, the same as in-process", async () => {
    const server = runtimeServer(new AgentRuntime([model("hello from the runtime")], undefined), "secret");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const remote = new RemoteRuntime(url, "secret");
      expect((await remote.models()).models.map((m) => m.id)).toEqual(["fake:model"]);
      const events: RunEvent[] = [];
      for await (const e of remote.run({ runId: "r", instruction: "", history: [], ask: asked("hi"), endings: [], tools: false })) events.push(e);
      expect(events.at(-1)).toMatchObject({ type: "done", text: "hello from the runtime" });
      await expect(new RemoteRuntime(url, "wrong").models()).rejects.toThrow(/401/);
    } finally {
      server.close();
    }
  });
});

describe("checking a run and continuing it", () => {
  it("sends a reply that talks about its own mechanism back once, and keeps the corrected one", async () => {
    const requests: RunRequest[] = [];
    const replies = ["The context shows you asked about Neon.", "You asked me about Neon on Monday."];
    const runtime: AgentRuntimePort = {
      models: async () => ({ models: [{ id: "fake:model", provider: "fake", label: "Fake", hint: "" }], defaultModel: "fake:model" }),
      say: async () => null,
      async *run(request) {
        requests.push(request);
        const text = replies[requests.length - 1];
        yield { type: "entry", entry: { kind: "said", text, toolCalls: [], stopReason: "end_turn" } };
        yield { type: "done", shape: "reply", text, rounds: 1, cutShort: false };
      },
    };
    const store = new SqliteMemory(":memory:");
    const chat = new ChatService({
      store, clock: new SystemClock(), models: new ModelCatalog(runtime), runtime,
      search: new SearchService({ name: "fake", available: true, read: async () => [], search: async () => [] }),
      recall: new RecallService(store), ledger: new LedgerService(store), log: () => {},
    });
    const events: TurnEvent[] = [];
    for await (const e of chat.turn({ message: "What did I ask on Monday?", timeZone: "UTC" })) events.push(e);
    const done = events.find((e) => e.type === "done");
    expect(requests).toHaveLength(2);
    expect(requests[1].ask).toMatchObject({ by: "runtime" });
    expect(done?.type === "done" && done.turn.lead).toBe(replies[1]);
    // Later turns replay the question and the settled answer only: the working stays out.
    const transcript = store.transcript(done?.type === "done" ? done.turn.conversationId : "");
    expect(transcript.map((e) => e.kind)).toEqual(["asked", "said"]);
    expect(transcript[1]).toMatchObject({ text: replies[1], toolCalls: [] });
  });
});

describe("citations found while the answer is written", () => {
  it("feeds each paragraph to a citation run that sees the same passages, and attaches what it finds", async () => {
    const requests: RunRequest[] = [];
    const page = { id: "S1abcd", title: "Neon pricing", url: "https://neon.com/pricing", domain: "neon.com", text: "Launch plan: $19 per month, billed monthly. Scale plan: $69 per month." };
    const paragraphs = ["Neon's Launch plan costs $19 a month [S1abcd].", "Scale is $69 a month [S1abcd]."];
    const runtime: AgentRuntimePort = {
      models: async () => ({ models: [{ id: "fake:model", provider: "fake", label: "Fake", hint: "" }], defaultModel: "fake:model" }),
      say: async () => null,
      async *run(request) {
        requests.push(request);
        if (request.instruction === CITE_INSTRUCTION) {
          const part = request.ask.text;
          const citations = [
            ...(part.includes("Launch plan costs") ? [{ after: "Launch plan costs $19 a month", sources: [{ id: "S1abcd", quote: "Launch plan: $19 per month" }] }] : []),
            ...(part.includes("Scale is") ? [{ after: "Scale is $69 a month", sources: [{ id: "S1abcd", quote: "Scale plan: $69 per month" }] }] : []),
          ];
          yield { type: "entry", entry: { kind: "said", text: "", toolCalls: [{ id: `c${requests.length}`, name: "answer_citations", arguments: { citations } }], stopReason: "tool_use" } };
          yield { type: "done", shape: "citations", text: "", answer: { citations }, rounds: 1, cutShort: false };
          return;
        }
        // The answering run: one search, then the answer, written paragraph by paragraph.
        const call = { id: "q1", name: "web_search", arguments: { query: "neon pricing" } };
        yield { type: "entry", entry: { kind: "said", text: "", toolCalls: [call], stopReason: "tool_use" } };
        yield { type: "entry", entry: { kind: "ran", results: [{ callId: "q1", name: "web_search", content: "…", failed: false, data: { results: [page], cached: false } }] } };
        const text = paragraphs.join("\n\n");
        for (const piece of [paragraphs[0], "\n\n", paragraphs[1]]) {
          yield { type: "delta", delta: { type: "text", text: piece } };
          await new Promise((r) => setTimeout(r, 5));
        }
        yield { type: "entry", entry: { kind: "said", text, toolCalls: [], stopReason: "end_turn" } };
        yield { type: "done", shape: "reply", text, rounds: 2, cutShort: false };
      },
    };
    const store = new SqliteMemory(":memory:");
    const chat = new ChatService({
      store, clock: new SystemClock(), models: new ModelCatalog(runtime), runtime,
      search: new SearchService({ name: "fake", available: true, read: async () => [], search: async () => [] }),
      recall: new RecallService(store), ledger: new LedgerService(store), citer: new Citer({ runtime, log: () => {} }), log: () => {},
    });
    const events: TurnEvent[] = [];
    for await (const e of chat.turn({ message: "What does Neon cost?", timeZone: "UTC" })) events.push(e);
    const cites = requests.filter((r) => r.instruction === CITE_INSTRUCTION);
    // It read exactly the passage the answer was written from, and nothing was sent back to the answer.
    expect(cites[0].ask.text).toContain(page.text);
    expect(requests.filter((r) => r.instruction !== CITE_INSTRUCTION)).toHaveLength(1);
    // One run per paragraph, in parallel, and the answer was done before its citations landed.
    expect(cites).toHaveLength(2);
    const done = events.findIndex((e) => e.type === "done");
    const last = events.at(-1);
    expect(last?.type).toBe("patch");
    expect(events.findLastIndex((e) => e.type === "patch")).toBeGreaterThan(done);
    const conversationId = (events[done] as Extract<TurnEvent, { type: "done" }>).turn.conversationId;
    const lead = store.turns(conversationId)[0].lead;
    expect(last?.type === "patch" && last.text).toBe(lead);
    expect(citationsIn(lead)).toEqual([
      { id: "S1abcd", quote: "Launch plan: $19 per month", verified: true },
      { id: "S1abcd", quote: "Scale plan: $69 per month", verified: true },
    ]);
  });
});

describe("indexing in the background", () => {
  it("answers first, then writes the card in a separate run with the exchange's context", async () => {
    const requests: RunRequest[] = [];
    const card = { kind: "new", summary: "Cheapest managed Postgres", entities: [{ name: "Neon", aliases: ["db host"] }], topics: [{ phrase: "Postgres hosting", aliases: ["managed database"] }], facts: [] };
    const runtime: AgentRuntimePort = {
      models: async () => ({ models: [{ id: "fake:model", provider: "fake", label: "Fake", hint: "" }], defaultModel: "fake:model" }),
      say: async () => null,
      async *run(request) {
        requests.push(request);
        if (request.tools === false) yield { type: "done", shape: "index", text: "", answer: card, rounds: 1, cutShort: false };
        else yield { type: "done", shape: "reply", text: "Neon is the cheapest.", rounds: 1, cutShort: false };
      },
    };
    const store = new SqliteMemory(":memory:");
    const ledger = new LedgerService(store);
    let indexed!: () => void;
    const finished = new Promise<void>((r) => (indexed = r));
    const chat = new ChatService({
      store, clock: new SystemClock(), models: new ModelCatalog(runtime), runtime,
      search: new SearchService({ name: "fake", available: true, read: async () => [], search: async () => [] }),
      recall: new RecallService(store), ledger,
      indexer: new Indexer({ runtime, ledger, log: (m) => m.startsWith("index") && indexed() }),
      log: () => {},
    });
    const events: TurnEvent[] = [];
    for await (const e of chat.turn({ message: "Cheapest Postgres host?", timeZone: "UTC" })) events.push(e);
    expect(events.at(-1)?.type).toBe("done");
    // The answering run was never offered an index card to write.
    expect(requests[0].endings.map((e) => e.name)).not.toContain("index");
    await finished;
    expect(requests[1]).toMatchObject({ tools: false, endings: [{ name: "index" }] });
    expect(requests[1].ask.text).toContain("Cheapest Postgres host?");
    expect(requests[1].ask.text).toContain("Neon is the cheapest.");
    expect(store.turnsWithTerms(["db host", "managed database"], new Date(Date.now() + 1000), 10).size).toBe(1);
  });
});
