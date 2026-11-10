import { describe, expect, it } from "vitest";
import { SqliteMemory } from "../src/adapters/store/sqlite.ts";
import type { TurnRecord } from "../src/domain/memory.ts";
import { RecallService } from "../src/services/recall.ts";
import { SearchCache, WebSearchTool } from "../src/services/web-search.ts";
import type { SearchProvider } from "../src/ports/search.ts";

const IST = "Asia/Kolkata";
const NOW = new Date("2026-11-10T08:30:00Z"); // Tue 10 Nov

function memoryWith(...turns: { at: string; question: string; answer: string; claims?: [string, string][] }[]) {
  const store = new SqliteMemory(":memory:");
  for (const t of turns) {
    const c = store.createConversation(t.question.slice(0, 20), new Date(t.at));
    const turn: TurnRecord = {
      id: crypto.randomUUID(), conversationId: c.id, at: t.at, question: t.question, answerText: t.answer, lead: t.answer,
      shape: "reply", sources: [], activity: [], model: "fake",
    };
    store.saveTurn(turn);
    store.saveClaims(turn, (t.claims ?? []).map(([subject, value]) => ({ subject, value })));
  }
  return store;
}

describe("recall", () => {
  const store = memoryWith(
    { at: "2026-11-03T05:00:00Z", question: "Cheapest managed Postgres hosting?", answer: "Neon and Supabase…", claims: [["Neon, Launch plan", "$19/month"]] },
    { at: "2026-11-09T06:00:00Z", question: "Shortlist CRM tools for a 20-person sales team", answer: "HubSpot, Pipedrive, Attio, Close, Folk" },
  );
  const recall = new RecallService(store);

  it("finds what was said on the day a message points at, with the facts stated then", () => {
    const { context, activity } = recall.recall("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", "current", NOW, IST);
    expect(context).toContain("Cheapest managed Postgres hosting?");
    expect(context).toContain("Neon, Launch plan: $19/month");
    expect(activity[0]).toMatchObject({ kind: "recall" });
    expect(activity[0].kind === "recall" && activity[0].label).toContain("1 exchange");
  });

  it("finds by topic when no date is given", () => {
    const { context } = recall.recall("Has anything changed with the CRM tools we shortlisted?", "current", NOW, IST);
    expect(context).toContain("Shortlist CRM tools");
  });

  it("says so when memory has nothing, instead of leaving the model to guess", () => {
    const { context } = recall.recall("What did I ask you on 1 November?", "current", NOW, IST);
    expect(context).toMatch(/no earlier exchanges match/);
  });

  it("stays out of the way when the message does not look back", () => {
    const { context, activity } = recall.recall("What's the latest Node LTS?", "current", NOW, IST);
    expect(activity).toEqual([]);
    expect(context).not.toContain("Postgres");
  });
});

describe("web_search tool", () => {
  const hits = (urls: string[]) => urls.map((url) => ({ title: url, url, excerpt: "…" }));

  it("numbers sources once per page across searches in a turn", async () => {
    const provider: SearchProvider = { name: "fake", available: true, search: async (q) => hits(q.query === "a" ? ["https://x.com/1", "https://y.com/2"] : ["https://y.com/2", "https://z.com/3"]) };
    const tool = new WebSearchTool(provider, new SearchCache(), () => {});
    const first = await tool.run({ id: "1", name: "web_search", arguments: { query: "a" } });
    const second = await tool.run({ id: "2", name: "web_search", arguments: { query: "b" } });
    expect(tool.sources.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);
    expect(first.content).toContain("[S2]");
    expect(second.content).toContain("[S2]");
    expect(second.content).toContain("[S3]");
  });

  it("asks the provider once for a repeated query", async () => {
    let calls = 0;
    const provider: SearchProvider = { name: "fake", available: true, search: async () => (calls++, hits(["https://x.com"])) };
    const cache = new SearchCache();
    await new WebSearchTool(provider, cache, () => {}).run({ id: "1", name: "web_search", arguments: { query: "same" } });
    await new WebSearchTool(provider, cache, () => {}).run({ id: "2", name: "web_search", arguments: { query: "same" } });
    expect(calls).toBe(1);
  });

  it("reports a failing provider as a failed result and a failed activity", async () => {
    const provider: SearchProvider = { name: "fake", available: true, search: async () => { throw new Error("429"); } };
    const seen: string[] = [];
    const result = await new WebSearchTool(provider, new SearchCache(), (a) => a.kind === "search" && a.failed && seen.push(a.failed)).run({ id: "1", name: "web_search", arguments: { query: "q" } });
    expect(result.failed).toBe(true);
    expect(seen).toEqual(["429"]);
  });

  it("rejects malformed arguments without calling the provider", async () => {
    let calls = 0;
    const provider: SearchProvider = { name: "fake", available: true, search: async () => (calls++, []) };
    const result = await new WebSearchTool(provider, new SearchCache(), () => {}).run({ id: "1", name: "web_search", arguments: { query: "q", since: "last week" } });
    expect(result.failed).toBe(true);
    expect(calls).toBe(0);
  });
});
