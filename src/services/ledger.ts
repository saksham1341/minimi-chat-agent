/**
 * The claims ledger: after an answer is sent, write down the facts it stated, with source and
 * date. Structured answers already are claims (a comparison's cells, a report's items) and are
 * recorded as they are; prose goes through the extractor. Runs after the person has their answer
 * and never fails a turn.
 */
import type { ClaimDraft, TurnRecord } from "../domain/memory.ts";
import type { ClaimExtractor } from "../ports/claims.ts";
import type { MemoryStore } from "../ports/memory.ts";
import type { z } from "zod";
import type { Changes, Comparison } from "../domain/answers.ts";

export class LedgerService {
  constructor(private readonly store: MemoryStore, private readonly extractor: ClaimExtractor) {}

  async record(turn: TurnRecord): Promise<number> {
    const claims = await this.claimsOf(turn);
    if (claims.length) this.store.saveClaims(turn, claims);
    return claims.length;
  }

  private async claimsOf(turn: TurnRecord): Promise<ClaimDraft[]> {
    const url = (ids: string[]) => turn.sources.find((s) => ids.includes(s.id))?.url;
    if (turn.shape === "comparison") {
      const c = turn.answer as z.infer<typeof Comparison>;
      return c.rows.flatMap((row) =>
        c.columns.map((column, i) => ({ subject: `${row.name}, ${column}`, value: row.cells[i] ?? "n/a", sourceUrl: url(row.sources) })),
      );
    }
    if (turn.shape === "changes") {
      const c = turn.answer as z.infer<typeof Changes>;
      return c.items.filter((i) => i.now).map((i) => ({ subject: i.subject, value: i.now!, sourceUrl: url(i.sources) }));
    }
    if (turn.shape === "choices" || !this.extractor.available || !turn.answerText.trim()) return [];
    return this.extractor.extract({ question: turn.question, answer: turn.answerText, sources: turn.sources });
  }
}
