import { describe, expect, it } from "vitest";
import { dateIn, isoDay, resolveTimeRefs } from "../src/domain/time.ts";

// Tuesday 10 November 2026, 14:00 in India.
const NOW = new Date("2026-11-10T08:30:00Z");
const IST = "Asia/Kolkata";

const day = (text: string, now = NOW, tz = IST) => resolveTimeRefs(text, now, tz).map((r) => isoDay(dateIn(r.from, tz)));

describe("resolveTimeRefs", () => {
  it("reads the three questions from the brief", () => {
    expect(day("On Monday we shortlisted 5 CRM tools")).toEqual(["2026-11-09"]);
    expect(day("What did I ask you on 3 November? Is your answer still correct today?")).toEqual(["2026-11-03"]);
    expect(day("Last Tuesday I asked you about Postgres hosting")).toEqual(["2026-11-03"]);
  });

  it("spans exactly one local day", () => {
    const [ref] = resolveTimeRefs("on 3 November", NOW, IST);
    expect(ref.from.toISOString()).toBe("2026-11-02T18:30:00.000Z");
    expect(ref.to.getTime() - ref.from.getTime()).toBe(24 * 3600 * 1000);
  });

  it("offers the other reading of 'last <weekday>' within the same week", () => {
    const thursday = new Date("2026-11-12T08:30:00Z");
    const [ref] = resolveTimeRefs("last Monday", thursday, IST);
    expect(isoDay(dateIn(ref.from, IST))).toBe("2026-11-09");
    expect(ref.alternative && isoDay(dateIn(ref.alternative.from, IST))).toBe("2026-11-02");
  });

  it("puts a date without a year in the past", () => {
    expect(day("on 3 December")).toEqual(["2025-12-03"]);
    expect(day("Nov 3rd")).toEqual(["2026-11-03"]);
  });

  it("depends on the person's time zone, not the server's", () => {
    const lateNightUtc = new Date("2026-11-09T20:00:00Z"); // Tue 01:30 in India, Mon 12:00 in LA
    expect(day("yesterday", lateNightUtc, IST)).toEqual(["2026-11-09"]);
    expect(day("yesterday", lateNightUtc, "America/Los_Angeles")).toEqual(["2026-11-08"]);
  });

  it("reads relative phrases", () => {
    expect(day("2 days ago")).toEqual(["2026-11-08"]);
    expect(day("last week")).toEqual(["2026-11-02"]);
    expect(resolveTimeRefs("last week", NOW, IST)[0].label).toContain("8 Nov");
  });

  it("ignores the future and plain numbers", () => {
    expect(day("next Monday")).toEqual([]);
    expect(day("a team of 20 people, 5 tools")).toEqual([]);
  });

  it("does not read names or other words as dates", () => {
    expect(day("Has Monday.com changed its pricing?")).toEqual([]);
    expect(day("I may 3 options to compare")).toEqual([]);
    expect(day("Is your answer still correct today?")).toEqual([]);
  });

  it("reads 'today' when it is about the conversation", () => {
    expect(day("What did I ask you today?")).toEqual(["2026-11-10"]);
  });

  it("reads the weekend and the other day", () => {
    const [weekend] = resolveTimeRefs("we talked over the weekend", NOW, IST);
    expect(isoDay(dateIn(weekend.from, IST))).toBe("2026-11-07");
    expect(weekend.to.getTime() - weekend.from.getTime()).toBe(2 * 24 * 3600 * 1000);
    expect(day("the other day you said")).toEqual(["2026-11-04"]);
  });
});
