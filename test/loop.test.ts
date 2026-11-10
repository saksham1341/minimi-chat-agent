import { describe, expect, it } from "vitest";
import { asked, type Entry, type Said } from "../src/agents/conversation.ts";
import { Inbox } from "../src/agents/inbox.ts";
import { stream, type LoopEvent } from "../src/agents/loop.ts";
import type { ChatModel, ModelRequest, ToolSurface } from "../src/agents/ports.ts";
import { ANSWER_SHAPES } from "../src/domain/answers.ts";

/** A model that plays a script, one `Said` per request, and remembers what it was asked. */
function scripted(...turns: Omit<Said, "kind" | "stopReason">[]) {
  const requests: ModelRequest[] = [];
  const model: ChatModel = {
    info: { id: "fake:model", provider: "fake", label: "Fake", hint: "" },
    async respond(request) {
      requests.push({ ...request, history: [...request.history] });
      const next = turns.shift() ?? { text: "out of script", toolCalls: [] };
      return { kind: "said", stopReason: next.toolCalls.length ? "tool_use" : "end_turn", ...next };
    },
  };
  return { model, requests };
}

const tools = (run: ToolSurface["run"] = async (call) => ({ callId: call.id, name: call.name, content: "results", failed: false })): ToolSurface => ({
  offered: () => [{ name: "web_search", description: "", inputSchema: {} }],
  run,
});

async function collect(events: AsyncIterable<LoopEvent>) {
  const out: LoopEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const call = (id: string, name = "web_search", args: Record<string, unknown> = { query: id }) => ({ id, name, arguments: args });
const entries = (events: LoopEvent[]) => events.flatMap((e) => (e.type === "entry" ? [e.entry] : []));
const done = (events: LoopEvent[]) => events.find((e) => e.type === "done") as Extract<LoopEvent, { type: "done" }>;

describe("the loop", () => {
  it("answers every call of a parallel round in one entry", async () => {
    const { model } = scripted({ text: "", toolCalls: [call("a"), call("b"), call("c")] }, { text: "answer", toolCalls: [] });
    const events = await collect(stream(model, tools(), { instruction: "", ask: asked("q") }));
    const ran = entries(events).filter((e) => e.kind === "ran");
    expect(ran).toHaveLength(1);
    expect(ran[0].kind === "ran" && ran[0].results.map((r) => r.callId)).toEqual(["a", "b", "c"]);
    expect(done(events)).toMatchObject({ shape: "reply", text: "answer" });
  });

  it("returns a tool that threw as a failed result rather than dropping it", async () => {
    const { model, requests } = scripted({ text: "", toolCalls: [call("a")] }, { text: "done", toolCalls: [] });
    const failing = tools(async () => {
      throw new Error("provider down");
    });
    const events = await collect(stream(model, failing, { instruction: "", ask: asked("q") }));
    const ran = entries(events).find((e) => e.kind === "ran");
    expect(ran?.kind === "ran" && ran.results[0]).toMatchObject({ callId: "a", failed: true });
    expect(requests[1].history.at(-1)).toEqual(ran);
  });

  it("ends on an answer shape, and answers the call so the next turn's history is valid", async () => {
    const comparison = {
      headline: "A is cheaper.", title: "t", columns: ["price"], takeaway: "x",
      rows: [{ name: "A", cells: ["1"], sources: [] }, { name: "B", cells: ["2"], sources: [] }],
    };
    const { model } = scripted({ text: "", toolCalls: [call("x", "answer_comparison", comparison)] });
    const events = await collect(stream(model, tools(), { instruction: "", ask: asked("q"), endings: ANSWER_SHAPES }));
    expect(done(events)).toMatchObject({ shape: "comparison", answer: comparison });
    const last = entries(events).at(-1) as Entry;
    expect(last.kind === "ran" && last.results[0].callId).toBe("x");
  });

  it("sends an invalid shape back to the model to fix", async () => {
    const { model, requests } = scripted(
      { text: "", toolCalls: [call("x", "answer_comparison", { title: "t" })] },
      { text: "plain answer instead", toolCalls: [] },
    );
    const events = await collect(stream(model, tools(), { instruction: "", ask: asked("q"), endings: ANSWER_SHAPES }));
    expect(requests).toHaveLength(2);
    expect(done(events).shape).toBe("reply");
  });

  it("refuses a shape called beside a search, but still runs the search", async () => {
    let searched = 0;
    const { model } = scripted(
      { text: "", toolCalls: [call("s"), call("x", "answer_choices", { question: "?", options: [] })] },
      { text: "ok", toolCalls: [] },
    );
    const events = await collect(
      stream(model, tools(async (c) => (searched++, { callId: c.id, name: c.name, content: "r", failed: false })), {
        instruction: "", ask: asked("q"), endings: ANSWER_SHAPES,
      }),
    );
    const ran = entries(events).find((e) => e.kind === "ran");
    expect(searched).toBe(1);
    expect(ran?.kind === "ran" && ran.results.map((r) => r.failed)).toEqual([false, true]);
  });

  it("withdraws search at the ceiling and makes the model answer", async () => {
    const forever = Array.from({ length: 10 }, (_, i) => ({ text: "", toolCalls: [call(`c${i}`)] }));
    const { model, requests } = scripted(...forever.slice(0, 3), { text: "best effort", toolCalls: [] });
    const events = await collect(stream(model, tools(), { instruction: "", ask: asked("q"), maxRounds: 3 }));
    expect(requests).toHaveLength(4);
    expect(requests[3].tools.some((t) => t.name === "web_search")).toBe(false);
    expect(done(events)).toMatchObject({ text: "best effort", cutShort: true });
  });

  it("takes back a tool call written as text and asks for the real call", async () => {
    const leaked = '<invoke name="answer_changes"><parameter name="title">x</parameter></invoke>';
    const { model, requests } = scripted({ text: leaked, toolCalls: [] }, { text: "A real answer.", toolCalls: [] });
    const events = await collect(stream(model, tools(), { instruction: "", ask: asked("q"), endings: ANSWER_SHAPES }));
    expect(events.some((e) => e.type === "retract")).toBe(true);
    expect(requests).toHaveLength(2);
    expect(done(events).text).toBe("A real answer.");
    expect(done(events).text).not.toMatch(/<invoke/);
  });

  it("never ends a turn with tool-call markup as the answer", async () => {
    const leaked = 'Here it is: <invoke name="answer_changes"></invoke>';
    const { model } = scripted(...Array.from({ length: 5 }, () => ({ text: leaked, toolCalls: [] })));
    const events = await collect(stream(model, tools(), { instruction: "", ask: asked("q"), endings: ANSWER_SHAPES }));
    expect(done(events).text).not.toMatch(/<invoke/);
  });

  it("stops bouncing invalid answers once past the ceiling", async () => {
    const invalid = { text: "draft", toolCalls: [call("x", "answer_comparison", { title: "t" })] };
    const { model, requests } = scripted(...Array.from({ length: 20 }, () => invalid));
    const events = await collect(stream(model, tools(), { instruction: "", ask: asked("q"), endings: ANSWER_SHAPES, maxRounds: 3 }));
    expect(requests.length).toBeLessThanOrEqual(6);
    expect(done(events)).toMatchObject({ shape: "reply", cutShort: true });
  });

});

describe("messages said to a run while it works", () => {
  it("join after the round's tool results, before the next request, all at once", async () => {
    const inbox = new Inbox();
    const { model, requests } = scripted({ text: "", toolCalls: [call("a")] }, { text: "answer to both", toolCalls: [] });
    // Said while the search runs.
    const searching = tools(async (c) => {
      inbox.put("only the free tiers, please");
      inbox.put("and in EUR");
      return { callId: c.id, name: c.name, content: "results", failed: false };
    });
    const events = await collect(stream(model, searching, { instruction: "", ask: asked("q"), inbox }));
    const tail = requests[1].history.slice(-3);
    expect(tail.map((e) => e.kind)).toEqual(["ran", "asked", "asked"]);
    expect(tail.slice(1).map((e) => (e as { text: string }).text)).toEqual(["only the free tiers, please", "and in EUR"]);
    expect(events.filter((e) => e.type === "dequeued")).toHaveLength(2);
    expect(inbox.size).toBe(0);
  });

  it("are left for the caller when the run ends without another round", async () => {
    const inbox = new Inbox();
    const { model } = scripted({ text: "answer", toolCalls: [] });
    inbox.put("too late for this run");
    const events = await collect(stream(model, tools(), { instruction: "", ask: asked("q"), inbox }));
    expect(events.some((e) => e.type === "dequeued")).toBe(false);
    expect(inbox.size).toBe(1);
  });
});

