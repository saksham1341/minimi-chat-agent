import { describe, expect, it } from "vitest";
import { bareCitations, citationsIn, malformedCitations, markUnverified, quoteFound, quoteProblems, withoutQuotes } from "../src/domain/quotes.ts";

const page = "Pricing. **Starter** — $20/seat/month, billed monthly. Professional: $100 per seat per month, billed annually.";
const snapshots = new Map([["S1", page]]);

describe("quoted citations", () => {
  it("reads quoted, plain and listed markers", () => {
    expect(citationsIn('Starter is $20 [S1 "Starter — $20/seat/month"] and so on [S2, S3].')).toEqual([
      { id: "S1", quote: "Starter — $20/seat/month", verified: true },
      { id: "S2" },
      { id: "S3" },
    ]);
  });

  it("finds a quote despite case, dashes, curly quotes and markdown, with ... for omissions", () => {
    expect(quoteFound("starter - $20/seat/month", page)).toBe(true);
    expect(quoteFound("Professional: $100 ... billed annually", page)).toBe(true);
  });

  it("does not find words the page does not say, or pieces out of order", () => {
    expect(quoteFound("Starter — $9/seat/month", page)).toBe(false);
    expect(quoteFound("billed annually ... Starter", page)).toBe(false);
  });

  it("names every citation that does not hold up", () => {
    const problems = quoteProblems(citationsIn('[S1 "Starter — $9/seat/month"] [S1] [S7 "anything"]'), snapshots);
    expect(problems.map((p) => p.reason)).toEqual(["not in source", "no quote", "unknown source"]);
  });

  it("marks failed quotes unverified and leaves good ones alone", () => {
    const text = 'Good [S1 "billed monthly"]. Bad [S1 "billed weekly"].';
    const marked = markUnverified(text, snapshots);
    expect(citationsIn(marked).map((c) => c.verified)).toEqual([true, false]);
  });

  it("strips quotes for search and recall, keeping the ids", () => {
    expect(withoutQuotes('Starter is $20 [S1 "Starter — $20/seat/month"].')).toBe("Starter is $20 [S1].");
  });

  it("refuses bare-number quotes and malformed brackets", () => {
    const problems = quoteProblems(citationsIn('[S1 "100"]'), snapshots);
    expect(problems.map((p) => p.reason)).toEqual(["too short"]);
    expect(malformedCitations('ok [S1 "billed monthly"] bad [S1 "100" and "10"]').map((p) => p.reason)).toEqual(["malformed"]);
  });

  it("catches a citation standing in for the fact, not one following it", () => {
    expect(bareCitations('- Extra branches: [S1 "$1.50/branch-month"] each').map((p) => p.reason)).toEqual(["bare"]);
    expect(bareCitations('Extra branches cost $1.50 a month [S1 "$1.50/branch-month"].')).toEqual([]);
    expect(bareCitations('Supported by two pages [S1 "billed monthly"][S2 "billed monthly too"].')).toEqual([]);
  });
});
