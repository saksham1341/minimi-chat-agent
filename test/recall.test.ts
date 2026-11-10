/**
 * Which earlier exchange a message means. The fixtures hold index cards as the answering model
 * would write them; the matching against them is software, tested on the brief's phrasings and on
 * the ways it has failed before.
 */
import { describe, expect, it } from "vitest";
import { SqliteMemory } from "../src/adapters/store/sqlite.ts";
import { namedDays } from "../src/domain/calendar.ts";
import { quoteDiff } from "../src/domain/diff.ts";
import type { ExchangeCard, TurnRecord } from "../src/domain/memory.ts";
import { topicsIn, withoutTopics } from "../src/domain/annotations.ts";
import { matchForm, phrases } from "../src/domain/text.ts";
import { dateIn, isoDay } from "../src/domain/time.ts";
import { LedgerService } from "../src/services/ledger.ts";
import { ago, RecallService } from "../src/services/recall.ts";

const IST = "Asia/Kolkata";
const TUESDAY = new Date("2026-11-10T08:30:00Z"); // Tue 10 Nov, 14:00 in India

interface Fixture {
  at: string;
  question: string;
  answer: string;
  terms: string[];
  kind?: ExchangeCard["kind"];
  facts?: { subject: string; value: string; quote?: string; url?: string }[];
}

function memoryWith(...fixtures: Fixture[]) {
  const store = new SqliteMemory(":memory:");
  for (const f of fixtures) {
    const c = store.createConversation(f.question.slice(0, 20), new Date(f.at));
    const turn: TurnRecord = {
      id: crypto.randomUUID(), conversationId: c.id, at: f.at, question: f.question, answerText: f.answer, lead: f.answer,
      shape: "reply", sources: (f.facts ?? []).filter((x) => x.url).map((x, i) => ({ id: `S${i}0000`, url: x.url!, title: "", domain: new URL(x.url!).hostname })), activity: [], model: "fake",
    };
    store.saveTurn(turn);
    store.saveCard(turn, { kind: f.kind ?? "new", summary: f.question, terms: f.terms.map(matchForm), facts: [] });
    const facts = (f.facts ?? []).map((x) => ({ subject: x.subject, value: x.value, quote: x.quote, sourceUrl: x.url }));
    if (facts.length) store.saveClaims(turn, facts, f.kind === "recheck" ? "observed" : "stated");
  }
  return store;
}

const postgres: Fixture = {
  at: "2026-11-03T05:00:00Z",
  question: "I'm picking managed Postgres hosting for a side project. Cheapest?",
  answer: "Neon's Launch plan is $19/month; Supabase Pro is $25.",
  terms: ["Postgres hosting", "postgres", "postgresql", "managed database", "db hosts", "database hosting", "Neon", "Supabase"],
  facts: [{ subject: "Neon, Launch plan", value: "$19/month", quote: "Launch $19/month", url: "https://neon.com/pricing" }],
};
const crm: Fixture = {
  at: "2026-11-09T06:00:00Z",
  question: "Shortlist 5 CRM tools for a 20-person sales team",
  answer: "HubSpot, Pipedrive, Attio, Close, Folk",
  terms: ["CRM", "CRM tools", "sales software", "HubSpot", "Pipedrive", "Attio", "Close", "Folk"],
};
const espresso: Fixture = { at: "2026-11-09T07:00:00Z", question: "Best espresso grinder under $300?", answer: "Baratza Encore ESP", terms: ["espresso grinder", "coffee grinder", "Baratza"] };
const today: Fixture = { at: "2026-11-10T04:00:00Z", question: "Which CRM has the best free tier?", answer: "HubSpot.", terms: ["CRM", "free tier", "HubSpot"] };

describe("which earlier exchange a message means", () => {
  const recall = new RecallService(memoryWith(postgres, crm, espresso, today));
  const top = (message: string) => {
    const preview = recall.preview(message, "current", TUESDAY, IST);
    return preview.filter((p) => p.confidence === preview[0]?.confidence).map((p) => `${p.day} ${p.confidence}`);
  };

  it("resolves the brief's three questions, with confidence", () => {
    expect(top("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed?")).toEqual(["2026-11-09 high"]);
    expect(top("What did I ask you on 3 November? Is your answer still correct today?")).toEqual(["2026-11-03 medium"]);
    expect(top("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?")).toEqual(["2026-11-03 high"]);
  });

  it("finds an exchange by how the person says it, through the model's aliases", () => {
    expect(top("a week ago-ish we went through some db hosts together, who came out cheapest back then?")).toEqual(["2026-11-03 medium"]);
    expect(top("Remind me which CRM tools we were looking at")).toContain("2026-11-09 medium");
  });

  it("never takes today's exchanges for 'Tuesday' said on a Tuesday, or for 'still correct today'", () => {
    expect(top("What did I ask you on Tuesday?")).toEqual(["2026-11-03 medium"]);
    expect(recall.preview("Is your answer still correct today?", "current", TUESDAY, IST)).toEqual([]);
  });

  it("is not fooled by names, numbers or filler", () => {
    expect(recall.preview("Has Monday.com changed its pricing?", "current", TUESDAY, IST)).toEqual([]);
    expect(recall.preview("Give me 5 ideas for a birthday dinner", "current", TUESDAY, IST)).toEqual([]);
    expect(recall.preview("Do I need to run anything now before the upgrade?", "current", TUESDAY, IST)).toEqual([]);
  });

  it("says plainly when a named day had nothing, and never shows what a day held unless it matched", () => {
    const { context } = recall.recall("What did I ask you on 1 November?", "current", TUESDAY, IST);
    expect(context).toMatch(/Nothing was asked on Sun, 1 Nov 2026/);
    expect(context).not.toContain("espresso");
    expect(context).not.toContain("Postgres");
  });

  it("gives the original answer's facts as the baseline, with their quotes", () => {
    const r = recall.recall("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", "current", TUESDAY, IST);
    expect(r.confidence).toBe("high");
    expect(r.baseline.map((c) => `${c.subject}: ${c.value} "${c.quote}"`)).toEqual(['Neon, Launch plan: $19/month "Launch $19/month"']);
  });
});

describe("a re-check never becomes the baseline", () => {
  const recheckOfIt: Fixture = {
    at: "2026-11-09T09:00:00Z",
    question: "Has Neon changed its pricing since we talked?",
    answer: "Launch is now $15.",
    terms: ["Neon", "Postgres hosting"],
    kind: "recheck",
    facts: [{ subject: "Neon, Launch plan", value: "$15/month", quote: "Launch $15", url: "https://neon.com/pricing" }],
  };
  const recall = new RecallService(memoryWith(postgres, recheckOfIt));

  it("keeps the original's facts as 'before' and lists later observations apart", () => {
    const r = recall.recall("Last Tuesday I asked you about Postgres hosting. Still correct?", "current", TUESDAY, IST);
    expect(r.baseline.map((c) => c.value)).toEqual(["$19/month"]);
    expect(r.context).toMatch(/Checked again since[\s\S]*Neon, Launch plan: \$15\/month/);
  });
});

describe("naming days", () => {
  const today = dateIn(TUESDAY, IST);
  const named = (message: string) => namedDays(phrases(message, 6), today, 60).map((n) => `${isoDay(n.day)} ${n.strength}`);

  it("generates the names of each day and finds them in the message", () => {
    expect(named("on 3 November")).toContain("2026-11-03 1");
    expect(named("yesterday")).toEqual(["2026-11-09 1"]);
    expect(named("the 3rd")).toContain("2026-11-03 0.7");
    expect(named("over the weekend")).toEqual(["2026-11-08 0.8", "2026-11-07 0.8"]);
  });

  it("names nothing it was not told", () => {
    expect(named("Monday.com pricing")).toEqual([]);
    expect(named("is it still correct today")).toEqual([]);
    expect(named("5 tools")).toEqual([]);
  });
});

describe("re-checking by quote", () => {
  it("says, word for word, whether each quote is still on the page, and shows what replaced it", () => {
    const claims = [
      { id: "", turnId: "", conversationId: "", origin: "stated" as const, observedAt: "", subject: "Neon, Launch", value: "$19/month", quote: "Launch $19/month", sourceUrl: "https://neon.com/pricing" },
      { id: "", turnId: "", conversationId: "", origin: "stated" as const, observedAt: "", subject: "Neon, Scale", value: "$69/month", quote: "Scale $69/month", sourceUrl: "https://neon.com/pricing" },
      { id: "", turnId: "", conversationId: "", origin: "stated" as const, observedAt: "", subject: "Supabase, Pro", value: "$25", quote: "Pro $25", sourceUrl: "https://supabase.com/pricing" },
    ];
    const page = "Plans\nLaunch $19/month for small apps.\nScale now $89/month, with more compute.";
    const rows = quoteDiff(claims, new Map([["https://neon.com/pricing", page], ["https://supabase.com/pricing", undefined]]));
    expect(rows.map((r) => r.status)).toEqual(["still there", "gone", "page unreadable"]);
    expect(rows[1].nearest).toBe("Scale now $89/month, with more compute.");
  });
});

describe("the ledger", () => {
  it("records a re-check's facts as observations, and a quote only with the value it says", () => {
    const store = new SqliteMemory(":memory:");
    const c = store.createConversation("x", new Date("2026-11-09T09:00:00Z"));
    const turn: TurnRecord = {
      id: crypto.randomUUID(), conversationId: c.id, at: "2026-11-09T09:00:00Z", question: "Has Neon changed?", answerText: "x", lead: "x",
      shape: "reply", sources: [{ id: "S10000", url: "https://neon.com/pricing", title: "", domain: "neon.com" }], activity: [], model: "fake",
    };
    store.saveTurn(turn);
    new LedgerService(store).refine(turn, {
      kind: "recheck", summary: "Neon re-check", entities: [{ name: "Neon", aliases: ["neon postgres"] }], topics: [],
      facts: [
        { subject: "Neon, Launch", value: "$15/month", source: "S10000", quote: "Launch $15/month" },
        { subject: "Neon, Scale", value: "$69/month", source: "S10000", quote: "Launch $15/month" },
      ],
    });
    const claims = store.claimsFor([turn.id]);
    expect(claims.map((x) => [x.origin, x.value, x.quote ?? null])).toEqual([["observed", "$15/month", "Launch $15/month"], ["observed", "$69/month", null]]);
  });
});

describe("a busy day", () => {
  const sameDay = (at: string, question: string, terms: string[]): Fixture => ({ at, question, answer: question, terms, facts: [{ subject: question, value: "$10/month", quote: "$10/month", url: `https://${terms[0].replace(/\W/g, "")}.com/pricing` }] });
  const day = [
    sameDay("2026-11-09T04:00:00Z", "Latest Node LTS?", ["node", "node lts"]),
    sameDay("2026-11-09T05:00:00Z", "Managed Postgres hosts?", ["postgres hosting", "managed database"]),
    sameDay("2026-11-09T06:00:00Z", "Best F1 driver this season?", ["formula 1", "f1 standings"]),
  ];

  it("lets the topic pick among the day's exchanges, and re-checks only those", () => {
    const r = new RecallService(memoryWith(...day)).recall("Yesterday we compared postgres hosting. Has pricing changed?", "other", TUESDAY, IST);
    expect(r.baseline.map((c) => c.subject)).toEqual(["Managed Postgres hosts?"]);
    expect(r.context).not.toContain("Latest Node LTS?");
  });

  it("is not confident which one a bare day means when several were asked", () => {
    const r = new RecallService(memoryWith(...day)).recall("Is what you told me yesterday still right?", "other", TUESDAY, IST);
    expect(r.confidence).toBe("low");
  });

  it("states how long ago an exchange was", () => {
    expect(ago("2026-11-10T08:28:00Z", TUESDAY)).toBe("2 minutes ago");
    expect(ago("2026-11-09T08:30:00Z", TUESDAY)).toBe("24 hours ago");
    expect(ago("2026-11-03T08:30:00Z", TUESDAY)).toBe("7 days ago");
  });
});

describe("topics the answer marks inline", () => {
  const answer = "[[Neon]] is the cheapest [[managed Postgres hosting]] here; Neon again. ```toml\n[[package]]\n```";

  it("are read once each, never from code", () => {
    expect(topicsIn(answer)).toEqual(["Neon", "managed Postgres hosting"]);
    expect(withoutTopics(answer)).toContain("Neon is the cheapest managed Postgres hosting here");
    expect(withoutTopics(answer)).toContain("[[package]]");
  });

  it("make the exchange findable by topic the moment it is answered, and the indexer's card replaces them", () => {
    const store = new SqliteMemory(":memory:");
    const c = store.createConversation("x", new Date("2026-11-09T09:00:00Z"));
    const turn: TurnRecord = {
      id: crypto.randomUUID(), conversationId: c.id, at: "2026-11-09T09:00:00Z", question: "Cheapest?", answerText: withoutTopics(answer), lead: answer,
      shape: "reply", sources: [], activity: [], model: "fake",
    };
    store.saveTurn(turn);
    const ledger = new LedgerService(store);
    const later = new Date("2026-11-10T00:00:00Z");
    ledger.record(turn);
    expect(store.turnsWithTerms([matchForm("managed postgres hosting")], later, 10).size).toBe(1);
    ledger.refine(turn, { kind: "new", summary: "s", entities: [{ name: "Neon", aliases: ["db host"] }], topics: [], facts: [] });
    expect(store.turnsWithTerms([matchForm("db host")], later, 10).size).toBe(1);
    expect(store.cardsFor([turn.id]).get(turn.id)?.summary).toBe("s");
  });
});
