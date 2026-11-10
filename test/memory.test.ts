import { describe, expect, it } from "vitest";
import { SqliteMemory } from "../src/adapters/store/sqlite.ts";
import type { TurnRecord } from "../src/domain/memory.ts";
import { RecallService } from "../src/services/recall.ts";
import { CitedSearch, SEARCH_TOOL, SearchService } from "../src/services/web-search.ts";
import { McpToolSurface } from "../src/agents/mcp.ts";
import { RunRegistry } from "../src/services/runs.ts";
import { handleMcp } from "../src/api/mcp.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { evidenceProblem } from "../src/domain/answers.ts";
import { isVendorSite, planReadAhead } from "../src/domain/recheck.ts";
import { ReadAhead } from "../src/services/read-ahead.ts";
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
    { at: "2026-11-09T07:00:00Z", question: "Best espresso grinder under $300?", answer: "Baratza Encore ESP" },
  );
  const recall = new RecallService(store);
  const asked = (message: string, now = NOW) => recall.recall(message, "current", now, IST).context;

  it("finds the brief's three questions by the words of their day and topic", () => {
    expect(asked("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed?")).toContain("Person asked: Shortlist CRM tools");
    expect(asked("What did I ask you on 3 November? Is your answer still correct today?")).toContain("Person asked: Cheapest managed Postgres hosting?");
    expect(asked("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?")).toContain("Neon, Launch plan: $19/month");
  });

  it("prefers the exchange that matches both the day and the topic", () => {
    const context = asked("On Monday we shortlisted 5 CRM tools. Has any of them changed?");
    expect(context.indexOf("Shortlist CRM tools")).toBeGreaterThan(-1);
  });

  it("shows the calendar, so the model can say a day had nothing", () => {
    const context = asked("What did I ask you on 1 November?");
    expect(context).toMatch(/Calendar \(today is Tue/);
    expect(context).not.toContain("Person asked");
  });

  it("is not fooled by names, numbers or filler that look like dates", () => {
    expect(asked("Has Monday.com changed its pricing?")).not.toContain("Person asked");
    expect(asked("Give me 5 ideas for a birthday dinner")).not.toContain("Person asked");
    expect(asked("Do I need to run anything now before the upgrade, one thing at a time?")).not.toContain("Person asked");
  });

  it("finds an earlier conversation however the person phrases it", () => {
    expect(asked("Remind me which CRMs we were looking at")).toContain("Person asked: Shortlist CRM tools");
  });

  it("previews, as the person types, exactly the days the turn will recall", () => {
    const preview = recall.preview("On Monday we shortlisted 5 CRM tools", "current", NOW, IST);
    expect(preview).toEqual([{ day: "2026-11-09", label: expect.stringContaining("9 Nov"), byDay: true, questions: ["Shortlist CRM tools for a 20-person sales team", "Best espresso grinder under $300?"] }]);
  });

  it("reads ahead only for what the message points at by day and topic", () => {
    const r = recall.recall("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", "current", NOW, IST);
    expect(r.readAhead.map((c) => c.subject)).toEqual(["Neon, Launch plan"]);
    expect(recall.recall("Remind me which CRMs we were looking at", "current", NOW, IST).readAhead).toEqual([]);
  });
});

describe("web search", () => {
  const hits = (urls: string[]) => urls.map((url) => ({ title: url, url, excerpt: "…" }));
  const provider = (search: SearchProvider["search"]): SearchProvider => ({ name: "fake", available: true, search });

  it("numbers sources once per page across searches in a run", async () => {
    const service = new SearchService(provider(async (q) => hits(q.query === "a" ? ["https://x.com/1", "https://y.com/2"] : ["https://y.com/2", "https://z.com/3"])));
    const cited = new CitedSearch(service);
    const first = await cited.answer({ query: "a" });
    const second = await cited.answer({ query: "b" });
    expect(cited.sources.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);
    expect(first.text).toContain("[S2]");
    expect(second.text).toContain("[S2]");
    expect(second.text).toContain("[S3]");
  });

  it("asks the provider once for a repeated query", async () => {
    let calls = 0;
    const service = new SearchService(provider(async () => (calls++, hits(["https://x.com"]))));
    await service.search({ query: "same" });
    await service.search({ query: "same" });
    expect(calls).toBe(1);
  });

  it("reports a failing provider as a failed answer and a failed activity", async () => {
    const service = new SearchService(provider(async () => { throw new Error("429"); }));
    const seen: string[] = [];
    const result = await new CitedSearch(service, (a) => { if (a.kind === "search" && a.failed) seen.push(a.failed); }).answer({ query: "q" });
    expect(result.failed).toBe(true);
    expect(seen).toEqual(["429"]);
  });
});

describe("the MCP boundary", () => {
  const serve = async (service: SearchService, runs: RunRegistry) => {
    const server = createServer((req, res) => void handleMcp(service, runs, req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`) };
  };
  const fake = (): SearchProvider => ({ name: "fake", available: true, search: async (q) => [{ title: `${q.query} page`, url: `https://example.com/${encodeURIComponent(q.query)}`, excerpt: "text" }] });

  it("keeps each run's searches apart, by the run id the runtime sends", async () => {
    const service = new SearchService(fake());
    const runs = new RunRegistry();
    const a = new CitedSearch(service);
    const b = new CitedSearch(service);
    runs.open("run-a", a);
    runs.open("run-b", b);
    const { server, url } = await serve(service, runs);
    try {
      const clientA = new McpToolSurface(url, { "x-run-id": "run-a" });
      const clientB = new McpToolSurface(url, { "x-run-id": "run-b" });
      expect((await clientA.offered()).map((t) => t.name)).toEqual([SEARCH_TOOL.name]);
      await clientA.run({ id: "1", name: "web_search", arguments: { query: "one" } });
      await clientA.run({ id: "2", name: "web_search", arguments: { query: "two" } });
      const fromB = await clientB.run({ id: "3", name: "web_search", arguments: { query: "three" } });
      expect(a.sources.map((s) => s.id)).toEqual(["S1", "S2"]);
      expect(b.sources.map((s) => s.id)).toEqual(["S1"]);
      expect(fromB.content).toContain("[S1] three page");
      await clientA.close();
      await clientB.close();
    } finally {
      server.close();
    }
  });

  it("serves any other MCP client too, numbered for its own call", async () => {
    const service = new SearchService(fake());
    const { server, url } = await serve(service, new RunRegistry());
    try {
      const outsider = new McpToolSurface(url);
      const result = await outsider.run({ id: "1", name: "web_search", arguments: { query: "neon pricing" } });
      expect(result.content).toContain("[S1] neon pricing page");
      const refused = await outsider.run({ id: "2", name: "web_search", arguments: { query: "x", since: "last week" } });
      expect(refused.failed).toBe(true);
      await outsider.close();
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

describe("reading ahead from the ledger", () => {
  const claim = (subject: string, value: string, sourceUrl?: string) => ({ id: "", turnId: "", conversationId: "", subject, value, sourceUrl, observedAt: "2026-11-09T06:00:00.000Z" });

  it("plans one live page read and one 'since' news search per vendor, not per source site", () => {
    const plan = planReadAhead([
      claim("HubSpot Sales Hub, Price/seat/month", "$20 (Starter)", "https://www.g2.com/products/hubspot/pricing"),
      claim("Zoho CRM, Price/seat/month", "$14 (Standard)", "https://www.g2.com/products/zoho-crm/pricing"),
      claim("Pipedrive, Price/seat/month", "$14 (Lite)", "https://www.pipedrive.com/en/pricing"),
    ]);
    expect(plan.filter((p) => p.kind === "page").map((p) => p.vendor)).toEqual(["HubSpot Sales Hub", "Zoho CRM", "Pipedrive"]);
    // An aggregator is never treated as the vendor's own site; the vendor's own domain is.
    expect(plan.find((p) => p.vendor === "HubSpot Sales Hub" && p.kind === "page")?.domains).toBeUndefined();
    expect(plan.find((p) => p.vendor === "Pipedrive" && p.kind === "page")?.domains).toEqual(["pipedrive.com"]);
    expect(plan.filter((p) => p.kind === "news").every((p) => p.since === "2026-11-09")).toBe(true);
  });

  it("knows a vendor's own site from an aggregator", () => {
    expect(isVendorSite("HubSpot Sales Hub", "hubspot.com")).toBe(true);
    expect(isVendorSite("Neon", "neon.tech")).toBe(true);
    expect(isVendorSite("HubSpot Sales Hub", "g2.com")).toBe(false);
    expect(isVendorSite("Zoho CRM", "capterra.com")).toBe(false);
  });

  it("hands a read already under way to the search that asks for it, once it names the vendor", async () => {
    let calls = 0;
    const service = new SearchService({ name: "fake", available: true, search: async () => (calls++, []) });
    const ahead = new ReadAhead(service, () => {});
    ahead.start([{ vendor: "Pipedrive", kind: "page", query: "Pipedrive pricing plans", fresh: true, max_results: 3 }]);
    expect(ahead.take({ query: "pipedrive pricing 2026", fresh: true })).toBeDefined();
    expect(ahead.take({ query: "hubspot pricing", fresh: true })).toBeUndefined();
    expect(ahead.take({ query: "pipedrive", since: "2026-11-09" })).toBeUndefined();
    await ahead.take({ query: "pipedrive pricing", fresh: true });
    expect(calls).toBe(1);
  });
});
