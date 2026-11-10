import { describe, expect, it } from "vitest";
import { SqliteMemory } from "../src/adapters/store/sqlite.ts";
import type { TurnRecord } from "../src/domain/memory.ts";
import { RecallService } from "../src/services/recall.ts";
import { CitedSearch, SEARCH_TOOL, SearchService } from "../src/services/web-search.ts";
import { McpToolSurface } from "../src/agents/mcp-tools.ts";
import type { ToolSurface } from "../src/agents/ports.ts";
import { handleMcp } from "../src/api/mcp.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { evidenceProblem } from "../src/domain/answers.ts";
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

  it("finds an earlier conversation however the person phrases it", () => {
    const { context } = recall.recall("Remind me which CRMs we were looking at", "current", NOW, IST);
    expect(context).toContain("Person asked: Shortlist CRM tools for a 20-person sales team");
  });

  it("stays out of the way when the message does not look back", () => {
    const { context, activity } = recall.recall("What's the latest Node LTS?", "current", NOW, IST);
    expect(activity).toEqual([]);
    expect(context).not.toContain("Postgres");
  });
});

describe("web search", () => {
  const hits = (urls: string[]) => urls.map((url) => ({ title: url, url, excerpt: "…" }));
  const provider = (search: SearchProvider["search"]): SearchProvider => ({ name: "fake", available: true, search });
  /** The service behind a stand-in for the MCP hop: the same JSON the server sends. */
  const surface = (service: SearchService): ToolSurface => ({
    offered: () => [],
    run: async (call) => {
      try {
        return { callId: call.id, name: call.name, failed: false, content: JSON.stringify({ results: await service.search(call.arguments as never) }) };
      } catch (error) {
        return { callId: call.id, name: call.name, failed: true, content: `Search failed: ${(error as Error).message}` };
      }
    },
  });

  it("numbers sources once per page across searches in an answer", async () => {
    const service = new SearchService(provider(async (q) => hits(q.query === "a" ? ["https://x.com/1", "https://y.com/2"] : ["https://y.com/2", "https://z.com/3"])));
    const cited = new CitedSearch(surface(service), () => {});
    const first = await cited.run({ id: "1", name: "web_search", arguments: { query: "a" } });
    const second = await cited.run({ id: "2", name: "web_search", arguments: { query: "b" } });
    expect(cited.sources.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);
    expect(first.content).toContain("[S2]");
    expect(second.content).toContain("[S2]");
    expect(second.content).toContain("[S3]");
  });

  it("asks the provider once for a repeated query", async () => {
    let calls = 0;
    const service = new SearchService(provider(async () => (calls++, hits(["https://x.com"]))));
    await service.search({ query: "same" });
    await service.search({ query: "same" });
    expect(calls).toBe(1);
  });

  it("reports a failing provider as a failed result and a failed activity", async () => {
    const service = new SearchService(provider(async () => { throw new Error("429"); }));
    const seen: string[] = [];
    const result = await new CitedSearch(surface(service), (a) => { if (a.kind === "search" && a.failed) seen.push(a.failed); }).run({ id: "1", name: "web_search", arguments: { query: "q" } });
    expect(result.failed).toBe(true);
    expect(seen).toEqual(["429"]);
  });
});

describe("the MCP boundary", () => {
  it("serves search to the runtime over MCP, with the contract the service declares", async () => {
    const searched: string[] = [];
    const fake: SearchProvider = { name: "fake", available: true, search: async (q) => (searched.push(q.query), [{ title: "Neon pricing", url: "https://neon.tech/pricing", excerpt: "Launch $19" }]) };
    const service = new SearchService(fake);
    const server = createServer((req, res) => void handleMcp(service, req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const runtime = new McpToolSurface(new URL(`http://127.0.0.1:${port}/mcp`));
      const offered = await runtime.offered();
      expect(offered.map((t) => t.name)).toEqual([SEARCH_TOOL.name]);
      expect(Object.keys((offered[0].inputSchema as { properties: object }).properties)).toContain("since");

      const cited = new CitedSearch(runtime, () => {});
      const result = await cited.run({ id: "1", name: "web_search", arguments: { query: "neon pricing" } });
      expect(searched).toEqual(["neon pricing"]);
      expect(result.content).toContain("[S1] Neon pricing");

      const refused = await runtime.run({ id: "2", name: "web_search", arguments: { query: "x", since: "last week" } });
      expect(refused.failed).toBe(true);
      expect(searched).toEqual(["neon pricing"]);
    } finally {
      server.close();
    }
  });
});

describe("the evidence rule for a 'changed' verdict", () => {
  const sources = [
    { id: "S1", url: "https://blog.example.com/old", title: "", domain: "blog.example.com", published: "2026-09-09" },
    { id: "S2", url: "https://example.com/pricing", title: "", domain: "example.com", live: true },
    { id: "S4", url: "https://roundup.example.net/best-crms", title: "", domain: "roundup.example.net" },
    { id: "S3", url: "https://example.com/news", title: "", domain: "example.com", published: "2026-11-10" },
  ];
  const report = (sourceIds: string[], status: "changed" | "unchanged" | "corrected" = "changed") => ({
    headline: "", title: "", summary: "", since: "2026-11-09",
    items: [{ subject: "Plan price", status, sources: sourceIds }],
  });

  it("refuses a change backed only by pages from before the baseline", () => {
    expect(evidenceProblem(report(["S1"]), sources)).toMatch(/S1 \(blog.example.com, published 2026-09-09\)/);
  });
  it("refuses a change with no source", () => {
    expect(evidenceProblem(report([]), sources)).toMatch(/cites no source/);
  });
  it("accepts a live page or a page from after the baseline", () => {
    expect(evidenceProblem(report(["S1", "S2"]), sources)).toBeNull();
    expect(evidenceProblem(report(["S3"]), sources)).toBeNull();
  });
  it("refuses a change or correction backed only by an undated third-party page", () => {
    expect(evidenceProblem(report(["S4"]), sources)).toMatch(/S4 \(roundup.example.net, undated/);
    expect(evidenceProblem(report(["S4"], "corrected"), sources)).toMatch(/marked corrected/);
  });

  it("does not police verdicts other than 'changed' and 'corrected'", () => {
    expect(evidenceProblem(report(["S1"], "unchanged"), sources)).toBeNull();
  });
});
