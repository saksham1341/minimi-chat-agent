import { describe, expect, it } from "vitest";
import { attachCitations } from "../src/domain/citations.ts";
import { bareCitations, citationsIn, malformedCitations, markUnverified, quoteFound, quoteProblems, repairCitations, withoutQuotes } from "../src/domain/quotes.ts";

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

  it("treats a line break inside a quote as a space", () => {
    expect(citationsIn('x [S1 "Starter — $20/seat/month,\\nbilled monthly"]').map((c) => quoteFound(c.quote!, page))).toEqual([true]);
  });
});

describe("slips of form are repaired, not sent back", () => {
  it("turns words without quote marks into a quoted citation when the page has them, a plain marker when not", () => {
    const fixed = repairCitations("Starter costs $20 a seat [S1 Starter — $20/seat/month]. Pro is pricier [S1 the premium plan].", snapshots);
    expect(malformedCitations(fixed)).toEqual([]);
    expect(citationsIn(fixed)).toEqual([{ id: "S1", quote: "Starter — $20/seat/month", verified: true }, { id: "S1" }]);
  });

  it("writes a citation repeated back to back once", () => {
    const text = 'Starter is $20 [S1 "$20/seat/month, billed monthly"][S1 "$20/seat/month, billed monthly"].';
    expect(citationsIn(repairCitations(text, snapshots))).toHaveLength(1);
  });
});

describe("a quote has to support its sentence's figure", () => {
  const verified = (text: string) => citationsIn(markUnverified(text, snapshots)).map((c) => c.verified);

  it("marks a real quote that does not state the sentence's price", () => {
    expect(verified('Starter is still $25 a seat [S1 "billed monthly. Professional"].')).toEqual([false]);
  });

  it("accepts the quote that does, alone or beside others", () => {
    expect(verified('Starter is $20 a seat [S1 "$20/seat/month, billed monthly"].')).toEqual([true]);
    expect(verified('Starter is $20 a seat [S1 "billed monthly. Professional"][S1 "$20/seat/month"].')).toEqual([true, true]);
  });

  it("leaves sentences without figures to the quote lookup alone", () => {
    expect(verified('Starter is billed monthly [S1 "billed monthly"].')).toEqual([true]);
  });
});

describe("citations found by the citation run", () => {
  it("attach where each claim ends, replacing the page tag the answer wrote there", () => {
    const answer = "Starter is $20 a seat [S1]. Pro is $100 [S1]. Support is email only.";
    const cited = attachCitations(answer, [
      { after: "Pro is $100", sources: [{ id: "S1", quote: "Professional: $100 per seat per month" }] },
      { after: "Starter is $20 a seat", sources: [{ id: "S1", quote: '$20/seat/month, "billed" monthly' }] },
      { after: "words that are not there", sources: [{ id: "S1", quote: "anything" }] },
    ]);
    expect(cited).toBe('Starter is $20 a seat [S1 "$20/seat/month, \'billed\' monthly"]. Pro is $100 [S1 "Professional: $100 per seat per month"]. Support is email only.');
    expect(citationsIn(cited).map((c) => c.verified)).toEqual([true, true]);
  });

  it("replace the tags even when the claim's words were copied on into them", () => {
    const answer = "- Pro: $100/month [S1][S2]\n- Starter: $20";
    const cited = attachCitations(answer, [{ after: "Pro: $100/month [S1][S2]", sources: [{ id: "S1", quote: "Professional: $100 per seat per month" }] }]);
    expect(cited).toBe('- Pro: $100/month [S1 "Professional: $100 per seat per month"]\n- Starter: $20');
  });

  it("leave a claim with no supporting page as the answer wrote it", () => {
    const answer = "Starter is $20 a seat [S1].";
    expect(attachCitations(answer, [{ after: "Starter is $20 a seat", sources: [] }])).toBe(answer);
  });
});
