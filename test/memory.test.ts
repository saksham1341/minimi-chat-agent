import { describe, expect, it } from "vitest";
import { SEARCH_TOOL, SearchService, sourceId } from "../src/services/web-search.ts";
import { SourceBook } from "../src/services/sources.ts";
import { McpToolSurface } from "../src/agents/mcp.ts";
import { handleMcp } from "../src/api/mcp.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { evidenceProblem } from "../src/domain/answers.ts";
import { isVendorSite } from "../src/domain/vendor.ts";
import type { SearchProvider } from "../src/ports/search.ts";

describe("web search", () => {
  const hits = (urls: string[]) => urls.map((url) => ({ title: url, url, excerpt: `text of ${url}` }));
  const provider = (search: SearchProvider["search"]): SearchProvider => ({ name: "fake", available: true, read: async () => [], search });

  it("gives a page the same id in every search, for every caller", async () => {
    const service = new SearchService(provider(async (q) => hits(q.query === "a" ? ["https://x.com/1", "https://y.com/2"] : ["https://y.com/2", "https://z.com/3"])));
    const a = await service.search({ query: "a" });
    const b = await service.search({ query: "b" });
    expect(a.results[1].id).toBe(b.results[0].id);
    expect(a.results[0].id).toMatch(/^S\d[0-9a-f]{4}$/);
    expect(new Set([...a.results, ...b.results].map((r) => r.id)).size).toBe(3);
  });

  it("asks the provider once for a repeated query, even while the first is still in flight", async () => {
    let calls = 0;
    const service = new SearchService(provider(async () => (calls++, await new Promise((r) => setTimeout(r, 20)), hits(["https://x.com"]))));
    const [first, second] = await Promise.all([service.search({ query: "same" }), service.search({ query: "same" })]);
    expect(calls).toBe(1);
    expect([first.cached, second.cached]).toEqual([false, true]);
  });
});

describe("the conversation's sources", () => {
  const result = (url: string) => ({ id: sourceId(url), title: url, url, domain: "x.com", text: `text of ${url}` });

  it("numbers pages for people in the order they were found, and keeps what each said", () => {
    const book = new SourceBook();
    book.enter([result("https://x.com/1"), result("https://x.com/2")], {});
    book.enter([result("https://x.com/2"), result("https://x.com/3")], { fresh: true });
    expect(book.sources.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(book.snapshots.get(sourceId("https://x.com/3"))).toBe("text of https://x.com/3");
    expect(book.sources[1].live).toBe(true);
  });

  it("carries earlier turns' sources, so a follow-up can cite them", () => {
    const first = new SourceBook();
    first.enter([result("https://x.com/1")], {});
    const next = new SourceBook({ sources: first.sources, snapshots: first.snapshots });
    next.enter([result("https://x.com/9")], {});
    expect(next.sources.map((s) => s.n)).toEqual([1, 2]);
    expect(next.sourcesFor(`as said before [${sourceId("https://x.com/1")} "text"]`).map((s) => s.n)).toEqual([1, 2]);
  });
});

describe("the MCP boundary", () => {
  it("serves the same stateless search to any client, as text and as data", async () => {
    let calls = 0;
    const service = new SearchService({ name: "fake", available: true, read: async () => [], search: async (q) => (calls++, [{ title: `${q.query} page`, url: "https://neon.com/pricing", excerpt: "Launch $19" }]) });
    const server = createServer((req, res) => void handleMcp(service, req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
      const runtimeClient = new McpToolSurface(url);
      const otherClient = new McpToolSurface(url);
      expect((await runtimeClient.offered()).map((t) => t.name)).toEqual([SEARCH_TOOL.name]);
      const one = await runtimeClient.run({ id: "1", name: "web_search", arguments: { query: "neon pricing" } });
      const two = await otherClient.run({ id: "2", name: "web_search", arguments: { query: "neon pricing" } });
      const id = sourceId("https://neon.com/pricing");
      expect(one.content).toContain(`[${id}] neon pricing page`);
      expect(one.data).toMatchObject({ results: [{ id, url: "https://neon.com/pricing" }], cached: false });
      expect(two.data).toMatchObject({ results: [{ id }], cached: true });
      expect(calls).toBe(1);
      const refused = await otherClient.run({ id: "3", name: "web_search", arguments: { query: "x", since: "last week" } });
      expect(refused.failed).toBe(true);
      await runtimeClient.close();
      await otherClient.close();
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


describe("telling a vendor's own site", () => {
  it("knows a vendor's own site from an aggregator", () => {
    expect(isVendorSite("HubSpot Sales Hub", "hubspot.com")).toBe(true);
    expect(isVendorSite("Neon", "neon.tech")).toBe(true);
    expect(isVendorSite("HubSpot Sales Hub", "g2.com")).toBe(false);
    expect(isVendorSite("Zoho CRM", "capterra.com")).toBe(false);
  });
});

describe("reading back a page an earlier answer cited", () => {
  const archive = { keptPages: (ids: string[]) => ids.filter((id) => id === "S1abcd").map((id) => ({ id, url: "https://neon.com/pricing", text: "Launch $19/month", seenAt: "2026-11-03T05:00:00Z" })) };
  const fresh = { name: "fake", available: true, search: async () => [], read: async (urls: string[]) => urls.map((url) => ({ url, title: "Neon pricing", text: "Launch $21/month" })) };

  it("gives the page as it was kept, by its id", async () => {
    const { results } = await new SearchService(fresh, archive).search({ pages: ["S1abcd"] });
    expect(results).toMatchObject([{ id: "S1abcd", url: "https://neon.com/pricing", text: "Launch $19/month" }]);
  });

  it("re-reads it live when asked for fresh", async () => {
    const { results } = await new SearchService(fresh, archive).search({ pages: ["S1abcd"], fresh: true });
    expect(results[0].text).toBe("Launch $21/month");
  });

  it("refuses ids no earlier answer cited", async () => {
    await expect(new SearchService(fresh, archive).search({ pages: ["S9ffff"] })).rejects.toThrow();
  });
});

