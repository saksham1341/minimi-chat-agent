import { describe, expect, it } from "vitest";
import { dateIn, dayWords, isoDay, startOfDay } from "../src/domain/time.ts";

const IST = "Asia/Kolkata";

describe("the calendar", () => {
  it("starts a day at local midnight in the person's zone", () => {
    expect(startOfDay({ y: 2026, m: 11, d: 3 }, IST).toISOString()).toBe("2026-11-02T18:30:00.000Z");
  });

  it("puts an instant on the person's local day, not the server's", () => {
    const lateNightUtc = new Date("2026-11-09T20:00:00Z"); // Tue 01:30 in India, Mon 12:00 in LA
    expect(isoDay(dateIn(lateNightUtc, IST))).toBe("2026-11-10");
    expect(isoDay(dateIn(lateNightUtc, "America/Los_Angeles"))).toBe("2026-11-09");
  });

  it("describes a day in the words people use for it, seen from today", () => {
    const today = { y: 2026, m: 11, d: 12 }; // a Thursday
    expect(dayWords({ y: 2026, m: 11, d: 3 }, today)).toEqual({ weekday: "tuesday", month: "november", day: "3", relative: ["last", "week"] });
    expect(dayWords({ y: 2026, m: 11, d: 11 }, today).relative).toEqual(["yesterday"]);
    expect(dayWords({ y: 2026, m: 11, d: 9 }, today).relative).toEqual(["this", "week"]);
  });
});
