/**
 * The ledger: after an answer, write down what the exchange was about and the facts it stated,
 * with source, quote, date and origin. The index card comes from the indexer's background run
 * (`services/indexer.ts`), and a structured answer's facts are its own cells and items.
 *
 *   origin    facts from a re-check are "observed", never "stated": a later "is it still correct?"
 *             measures against what the original answer said, not against the last check
 *   quotes    a fact keeps a quote only if the quote contains its value: a row's quote about the
 *             Starter price is not evidence for the Enterprise one
 */
import type { z } from "zod";
import { refId, type Changes, type Comparison, type SourceRef } from "../domain/answers.ts";
import { fallbackCard, toCard, type IndexCard } from "../domain/card.ts";
import type { ClaimDraft, ExchangeCard, TurnRecord } from "../domain/memory.ts";
import { topicsIn } from "../domain/annotations.ts";
import { matchForm, normalise } from "../domain/text.ts";
import type { MemoryStore } from "../ports/memory.ts";

export class LedgerService {
  constructor(private readonly store: MemoryStore) {}

  /**
   * The moment the answer is done: a default card from what software can read off the answer (the
   * topics the model marked inline, the rows of a table, the sites it drew on), so the exchange can
   * be found by topic straight away, and a structured answer's facts, which are its own cells.
   */
  record(turn: TurnRecord): ExchangeCard {
    const marked = topicsIn(`${turn.lead}\n${JSON.stringify(turn.answer ?? "")}`);
    const card = fallbackCard(turn.sources, [...marked, ...namesIn(turn)]);
    this.store.saveCard(turn, card);
    if (turn.shape !== "reply") {
      const facts = this.cellFacts(turn);
      if (facts.length) this.store.saveClaims(turn, facts, turn.shape === "changes" ? "observed" : "stated");
    }
    return card;
  }

  /**
   * The indexer's card, when it arrives: it replaces the default one (keeping the marked topics as
   * extra ways in) and brings a prose answer's facts, with their quotes.
   */
  refine(turn: TurnRecord, written: IndexCard): ExchangeCard {
    const base = toCard(written, turn.sources);
    const marked = topicsIn(turn.lead).map(matchForm);
    const card = { ...base, terms: [...new Set([...base.terms, ...marked])] };
    this.store.saveCard(turn, card);
    if (turn.shape === "reply" && turn.sources.length) {
      // A fact keeps its quote only if the quote says its value. An answer from memory alone
      // (no sources) restates old facts; recording them now would re-date them.
      const facts = card.facts.map((f) => (f.quote && !says(f.quote, f.value) ? { ...f, quote: undefined } : f));
      if (facts.length) this.store.saveClaims(turn, facts, card.kind === "recheck" ? "observed" : "stated");
    }
    return card;
  }

  private cellFacts(turn: TurnRecord): ClaimDraft[] {
    const evidence = (refs: SourceRef[], value: string) => {
      // The quote that says this value, if any does; otherwise the first source, unquoted.
      const quoted = refs.find((r): r is Exclude<SourceRef, string> => typeof r !== "string" && !!r.quote && says(r.quote, value));
      const id = quoted ? quoted.id : refs.map(refId)[0];
      return { sourceUrl: turn.sources.find((s) => s.id === id)?.url, ...(quoted ? { quote: quoted.quote } : {}) };
    };
    if (turn.shape === "comparison") {
      const c = turn.answer as z.infer<typeof Comparison>;
      return c.rows.flatMap((row) => c.columns.map((column, i) => {
        const value = row.cells[i] ?? "n/a";
        return { subject: `${row.name}, ${column}`, value, ...evidence(row.sources, value) };
      }));
    }
    if (turn.shape === "changes") {
      const c = turn.answer as z.infer<typeof Changes>;
      return c.items.filter((i) => i.now).map((i) => ({ subject: i.subject, value: i.now!, ...evidence(i.sources, i.now!) }));
    }
    return [];
  }
}

/** Does the quote contain the value's figures (or, with none, its words)? */
function says(quote: string, value: string): boolean {
  const q = normalise(quote);
  // Figures of two characters or more: a lone "1" is inside every quote with a "100" in it.
  const figures = value.match(/\d[\d,.]*/g)?.map((f) => f.replace(/,/g, "").replace(/\.$/, "")).filter((f) => f.length > 1) ?? [];
  if (figures.length) return figures.some((f) => q.replace(/,/g, "").includes(f));
  return normalise(value).split(" ").filter((w) => w.length > 3).some((w) => q.includes(w));
}

/** Names a structured answer is about (its rows, its items), for the fallback card. */
function namesIn(turn: TurnRecord): string[] {
  const a = turn.answer as { rows?: { name: string }[]; items?: { subject: string }[] } | undefined;
  return [...(a?.rows ?? []).map((r) => r.name), ...(a?.items ?? []).map((i) => i.subject.split(",")[0])];
}
