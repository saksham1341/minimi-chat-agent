/**
 * The ledger: after an answer, write down what the exchange was about and the facts it stated,
 * with source, quote, date and origin. All of it comes from the answer itself: the model wrote the
 * index card in the same response (`domain/card.ts`), and a structured answer's facts are its own
 * cells and items. No second model call.
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
import { normalise } from "../domain/text.ts";
import type { MemoryStore } from "../ports/memory.ts";

export class LedgerService {
  constructor(private readonly store: MemoryStore) {}

  record(turn: TurnRecord, written?: IndexCard): ExchangeCard {
    const card = written ? toCard(written, turn.sources) : fallbackCard(turn.sources, namesIn(turn));
    this.store.saveCard(turn, card);
    const facts = this.factsOf(turn, card);
    const origin = card.kind === "recheck" || turn.shape === "changes" ? "observed" : "stated";
    if (facts.length) this.store.saveClaims(turn, facts, origin);
    return card;
  }

  private factsOf(turn: TurnRecord, card: ExchangeCard): ClaimDraft[] {
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
    // An answer from memory alone restates old facts; recording them now would re-date them.
    if (!turn.sources.length) return [];
    return card.facts.map((f) => (f.quote && !says(f.quote, f.value) ? { ...f, quote: undefined } : f));
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
