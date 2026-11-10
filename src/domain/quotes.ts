/**
 * Quoted citations, and the check that keeps them honest.
 *
 * The model cites with the words it relied on: `[S3 "Starter is $20 per seat per month"]`. The
 * harness holds the exact text each source showed the model (its snapshot), so whether that quote
 * is really there is not a judgement, it is a lookup, and a quote that is not there goes back to
 * the model to fix. Any model can do this; nothing here depends on a provider's citation feature.
 *
 * Matching ignores what copying legitimately changes (case, whitespace, curly vs straight quotes,
 * dashes, markdown emphasis) and lets "..." stand for words left out, in order.
 */

export interface Citation {
  id: string;
  quote?: string;
  /** False when the quote could not be found in the source's snapshot after a retry. */
  verified?: boolean;
}

/** `[S3f2a1]`, `[S3f2a1 "quote"]`, `[S3f2a1 !"quote"]` (marked unverified), and lists. Older ids (`S3`) too. */
const MARKER = /\[(S\d[0-9a-f]*)(?:\s+(!?)"((?:[^"\\]|\\.)*)")?((?:\s*,\s*S\d[0-9a-f]*)*)\]/g;

export function citationsIn(text: string): Citation[] {
  const found: Citation[] = [];
  for (const m of text.matchAll(MARKER)) {
    found.push({ id: m[1], ...(m[3] !== undefined ? { quote: unescape(m[3]), verified: m[2] !== "!" } : {}) });
    for (const extra of (m[4] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) found.push({ id: extra });
  }
  return found;
}

/** The text with quotes removed, `[S3]` markers kept: for recall, search and the ledger's eyes. */
export function withoutQuotes(text: string): string {
  return text.replace(MARKER, (_m, id: string, _bang, _quote, rest: string) => `[${id}${rest ?? ""}]`);
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/[*_`#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Is `quote` in `snapshot`? Pieces separated by "..." must appear in order. */
export function quoteFound(quote: string, snapshot: string): boolean {
  const haystack = fold(snapshot);
  let from = 0;
  for (const piece of quote.split(/\.{3}|…/).map(fold).filter(Boolean)) {
    const at = haystack.indexOf(piece, from);
    if (at < 0) return false;
    from = at + piece.length;
  }
  return true;
}

export interface QuoteProblem {
  id: string;
  quote?: string;
  reason: "unknown source" | "not in source" | "no quote" | "too short" | "malformed" | "bare";
}

/** A quote has to state something: a phrase, not a bare number that any page contains. */
const tooShort = (quote: string) => quote.trim().length < 12 && quote.trim().split(/\s+/).length < 3;

/**
 * Citations standing in for the fact: "Price: [S1 "$20/seat"]" shows the reader a label and a
 * footnote, with the number only in the hidden quote. A citation follows a statement, so one
 * directly after a colon (or opening a line) has nothing visible to support.
 */
export function bareCitations(text: string): QuoteProblem[] {
  return [...text.matchAll(MARKER)]
    .filter((m) => {
      // The line up to the citation, without its bullet, bold labels and emphasis marks.
      const line = text.slice(text.lastIndexOf("\n", m.index - 1) + 1, m.index);
      const stated = line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").replace(/\*\*[^*]*\*\*/g, "").replace(/[`*_]/g, "").trim();
      return stated === "" || stated.endsWith(":");
    })
    .map((m) => ({ id: m[1], quote: m[3], reason: "bare" as const }));
}

/** `[S1 "100" and "10"]` and the like: brackets that name a source but are not a citation. */
export function malformedCitations(text: string): QuoteProblem[] {
  const valid = new Set([...text.matchAll(MARKER)].map((m) => m.index));
  return [...text.matchAll(/\[(S\d[0-9a-f]*)\b[^\]\n]*\]/g)]
    .filter((m) => !valid.has(m.index))
    .map((m) => ({ id: m[1], quote: m[0], reason: "malformed" as const }));
}

/** Every citation that does not hold up against the snapshots the harness kept. */
export function quoteProblems(citations: Citation[], snapshots: ReadonlyMap<string, string>): QuoteProblem[] {
  const problems: QuoteProblem[] = [];
  for (const c of citations) {
    const snapshot = snapshots.get(c.id);
    if (snapshot === undefined) problems.push({ id: c.id, quote: c.quote, reason: "unknown source" });
    else if (!c.quote) problems.push({ id: c.id, reason: "no quote" });
    else if (tooShort(c.quote)) problems.push({ id: c.id, quote: c.quote, reason: "too short" });
    else if (!quoteFound(c.quote, snapshot)) problems.push({ id: c.id, quote: c.quote, reason: "not in source" });
  }
  return problems;
}

export function describeProblems(problems: QuoteProblem[]): string {
  const lines = problems.slice(0, 12).map((p) =>
    p.reason === "unknown source"
      ? `- ${p.id} is not one of this answer's search results`
      : p.reason === "no quote"
        ? `- ${p.id} is cited without a quote`
        : p.reason === "too short"
          ? `- ${p.id} "${p.quote}" is too short to show anything; quote the phrase that states the fact`
          : p.reason === "bare"
            ? `- ${p.id} "${p.quote}" stands in for the fact; state it in your sentence, then cite`
            : p.reason === "malformed"
            ? `- ${p.quote} is not a citation; write one per bracket as [${p.id} "exact words"]`
            : `- ${p.id} "${p.quote}" is not in ${p.id}'s text`,
  );
  return (
    `Some citations do not hold up against the search results:\n${lines.join("\n")}\n` +
    `Copy each quote exactly from the result you cite (use ... for words you leave out), cite a result that ` +
    `does say it, or drop the claim.`
  );
}

/**
 * Fixes what is only a slip of form, so it never costs a rewrite: `[S41fce drivers' standings]`
 * (words without quote marks) becomes a quoted citation when the words are on the page and a plain
 * marker when not, and a citation repeated back to back is written once.
 */
export function repairCitations(text: string, snapshots: ReadonlyMap<string, string>): string {
  const valid = new Set([...text.matchAll(MARKER)].map((m) => m.index));
  const fixed = text.replace(/\[(S\d[0-9a-f]*)\b([^\]\n]*)\]/g, (m, id: string, inner: string, at: number) => {
    if (valid.has(at)) return m;
    const words = inner.replace(/["“”]/g, " ").replace(/^[\s,:;-]+|[\s,:;-]+$/g, "").replace(/\s+/g, " ");
    const snapshot = snapshots.get(id);
    return snapshot !== undefined && !tooShort(words) && quoteFound(words, snapshot) ? `[${id} "${words}"]` : `[${id}]`;
  });
  return fixed.replace(/(\[S\d[0-9a-f]*[^\]\n]*\])(?:\s*\1)+/g, "$1");
}

/** Prices, percentages and versions: the figures a sentence can get wrong. */
const FIGURE = /[$€£¥₹]\s?\d[\d,.]*|\d[\d,.]*\s?%|\b\d+\.\d+(?:\.\d+)?\b/g;
const figuresIn = (s: string) => [...s.matchAll(FIGURE)].map((m) => m[0].replace(/[\s,$€£¥₹%]/g, "").replace(/\.$/, "")).filter(Boolean);

/**
 * Marks citations that do not hold up as unverified (`[S3 !"..."]`), so the screen can say so. A
 * quote holds up when it is on the page and, if the sentence it supports states a price, percentage
 * or version, says at least one of them: "Still $5/mo" citing "at the same price as the Eco plan"
 * quotes a real page and still shows nothing about $5.
 */
export function markUnverified(text: string, snapshots: ReadonlyMap<string, string>): string {
  const markers = [...text.matchAll(MARKER)];
  const supported = new Map<number, boolean>();
  for (let i = 0; i < markers.length; ) {
    // Citations side by side support the same sentence, together.
    let j = i;
    while (j + 1 < markers.length && /^\s*$/.test(text.slice(markers[j].index + markers[j][0].length, markers[j + 1].index))) j++;
    const group = markers.slice(i, j + 1);
    const figures = figuresIn(claimBefore(text, group[0].index, i ? markers[i - 1].index + markers[i - 1][0].length : 0));
    const quotes = group.map((m) => (m[3] === undefined ? "" : unescape(m[3]).replace(/[\s,]/g, ""))).join(" ");
    const ok = !figures.length || figures.some((f) => quotes.includes(f));
    for (const m of group) supported.set(m.index, ok);
    i = j + 1;
  }
  return text.replace(MARKER, (m, id: string, _bang, quote: string | undefined, rest: string, at: number) => {
    if (quote === undefined) return m;
    const snapshot = snapshots.get(id);
    const ok = snapshot !== undefined && quoteFound(unescape(quote), snapshot) && supported.get(at) !== false;
    return ok ? m : `[${id} !"${quote}"${rest ?? ""}]`;
  });
}

/** The sentence a citation at `at` follows: back to the sentence's start or the previous citation. */
function claimBefore(text: string, at: number, floor: number): string {
  const before = text.slice(floor, at);
  const line = before.slice(before.lastIndexOf("\n") + 1);
  const sentences = line.split(/(?<=[.!?])\s+(?=[A-Z*(\["])/);
  const last = sentences.at(-1) ?? "";
  // "…a month each. [S1 "…"]": the citation follows the full stop, so the claim is the sentence before.
  return last.trim().split(/\s+/).length < 3 && sentences.length > 1 ? sentences.at(-2)! : last;
}

// A model copying across a line break writes \n: that is whitespace, not the letter n.
const unescape = (s: string) => s.replace(/\\[nrt]/g, " ").replace(/\\(.)/g, "$1");
