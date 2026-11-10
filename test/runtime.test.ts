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
import { Indexer } from "../src/services/indexer.ts";
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
  it("sends an answer whose citations do not hold up back once, and keeps the corrected one", async () => {
    const requests: RunRequest[] = [];
    const replies = ['Neon costs $19 [S9abcd "Launch $19"].', "Neon's Launch plan costs $19 a month."];
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
      store,
      clock: new SystemClock(),
      models: new ModelCatalog(runtime),
      runtime,
      search: new SearchService({ name: "fake", available: true, read: async () => [], search: async () => [] }),
      recall: new RecallService(store),
      ledger: new LedgerService(store),
      log: () => {},
    });
    const events: TurnEvent[] = [];
    for await (const e of chat.turn({ message: "What does Neon cost?", timeZone: "UTC" })) events.push(e);
    const done = events.find((e) => e.type === "done");
    expect(requests).toHaveLength(2);
    expect(requests[1].ask).toMatchObject({ by: "runtime" });
    expect(requests[1].ask.text).toMatch(/S9abcd is not one of this answer's search results/);
    expect(done?.type === "done" && done.turn.lead).toBe("Neon's Launch plan costs $19 a month.");
    // Later turns replay the question and the settled answer only: the working stays out.
    const transcript = store.transcript(done?.type === "done" ? done.turn.conversationId : "");
    expect(transcript.map((e) => e.kind)).toEqual(["asked", "said"]);
    expect(transcript[1]).toMatchObject({ text: "Neon's Launch plan costs $19 a month.", toolCalls: [] });
    expect(events.some((e) => e.type === "revise")).toBe(true);
  });

  it("corrects citations with edits in place, leaving the rest of the reply as written", async () => {
    const requests: RunRequest[] = [];
    const reply = 'Neon is the cheapest. Its Launch plan costs $19 [S9abcd "Launch $19"]. Supabase Pro is $25.';
    const runtime: AgentRuntimePort = {
      models: async () => ({ models: [{ id: "fake:model", provider: "fake", label: "Fake", hint: "" }], defaultModel: "fake:model" }),
      say: async () => null,
      async *run(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "entry", entry: { kind: "said", text: reply, toolCalls: [], stopReason: "end_turn" } };
          yield { type: "done", shape: "reply", text: reply, rounds: 1, cutShort: false };
        } else {
          const answer = { edits: [{ find: ' [S9abcd "Launch $19"]', replace: "" }] };
          yield { type: "entry", entry: { kind: "said", text: "", toolCalls: [{ id: "f1", name: "answer_fixes", arguments: answer }], stopReason: "tool_use" } };
          yield { type: "done", shape: "fixes", text: "", answer, rounds: 1, cutShort: false };
        }
      },
    };
    const store = new SqliteMemory(":memory:");
    const chat = new ChatService({
      store, clock: new SystemClock(), models: new ModelCatalog(runtime), runtime,
      search: new SearchService({ name: "fake", available: true, read: async () => [], search: async () => [] }),
      recall: new RecallService(store), ledger: new LedgerService(store), log: () => {},
    });
    const events: TurnEvent[] = [];
    for await (const e of chat.turn({ message: "Cheapest Postgres host?", timeZone: "UTC" })) events.push(e);
    expect(requests[1].endings.map((e) => e.name)).toEqual(["fixes"]);
    const expected = "Neon is the cheapest. Its Launch plan costs $19. Supabase Pro is $25.";
    expect(events.find((e) => e.type === "patch")).toMatchObject({ text: expected });
    expect(events.some((e) => e.type === "revise")).toBe(false);
    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.turn.lead).toBe(expected);
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
