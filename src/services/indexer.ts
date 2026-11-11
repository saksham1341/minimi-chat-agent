/**
 * Indexing: after the answer is on screen, a separate run writes the exchange's index card, the
 * metadata recall matches against later (`services/recall.ts`).
 *
 * Its own call, in the background, for two reasons. The person never waits for it: the answer ends
 * when its text does. And it gets the context a good card needs, which the answering model, busy
 * answering, was never asked to think about: the earlier exchanges in this conversation (so "what
 * about Render?" is indexed as Postgres hosting, not as a bare name), what memory matched the
 * message to (so a re-check is labelled one), the question with anything said while it worked,
 * the answer with its citations, and the pages behind them.
 *
 * It costs one model call per turn. Until it lands, and if it fails, the exchange has the default
 * card the ledger saved when the answer was done: the topics the answer marked inline, its table
 * rows and its sites. So an exchange is findable by topic from the moment it is answered.
 */
import { randomUUID } from "node:crypto";
import { asked } from "../agents/conversation.ts";
import { INDEX_SHAPE } from "../domain/answers.ts";
import { IndexCard } from "../domain/card.ts";
import type { TurnRecord } from "../domain/memory.ts";
import { describeNow } from "../domain/time.ts";
import type { AgentRuntimePort } from "../ports/runtime.ts";
import type { LedgerService } from "./ledger.ts";

export const INDEX_INSTRUCTION = `You index one exchange between a person and an assistant, so the assistant can find it again when the person refers back to it later: often days later, vaguely, and without the names ("the db hosts thing", "those CRM tools", "what you told me on Monday"). Call answer_index once with the card. Write nothing else.

- entities: every vendor, product, plan, technology, organisation or person the exchange was about, including ones it inherits from earlier in the conversation when the question continues them. For each, aliases: the generic category ("database", "db", "CRM", "hosting"), casual shorthand, abbreviations, common misspellings, and the plain-language version someone who forgot the name would use.
- topics: what it was about, as short phrases ("Postgres hosting", "CRM pricing for small teams"), each with the same kinds of aliases. Name the subject the person cares about, not the mechanics of the answer.
- kind: "recheck" when the question asks whether an earlier answer still holds or what changed since (a matched earlier exchange is a strong hint); "followup" when it continues this conversation's earlier question; "chat" for small talk; otherwise "new".
- summary: what was asked and answered, at most 20 words, specific enough to tell it apart from similar exchanges.
- An exchange that only recalls or lists earlier ones ("what have we talked about?", "what did I ask on Monday?") is about the conversation, not the topics it lists: kind "chat", one topic like "recap of earlier conversations", no entities or facts from what it listed. Those exchanges are indexed already, and indexing them again here would make every recap compete with the real one.
- facts: only for a prose answer. Each checkable fact it states from a cited source (prices, limits, dates, versions, launches): the subject, specific ("Neon, Launch plan"); the value as stated, with its figure and unit; the source id it cited; and the exact quoted words of that citation. Never a fact the answer did not state. Empty for a table or what-changed answer, whose cells are recorded separately.`;

export interface IndexContext {
  /** The model that writes the card: the light one. */
  model: string;
  /** This conversation's earlier exchanges, oldest first. */
  earlier: TurnRecord[];
  /** Earlier exchanges from other conversations that memory matched the question to. */
  matched: { at: string; question: string }[];
  confidence: string;
  timeZone: string;
}

export class Indexer {
  constructor(
    private readonly deps: { runtime: AgentRuntimePort; ledger: LedgerService; log: (message: string) => void },
  ) {}

  /** Writes the turn's card, replacing the default one. Never throws: a failed run leaves the default card. */
  async index(turn: TurnRecord, context: IndexContext): Promise<void> {
    const { runtime, ledger, log } = this.deps;
    const started = Date.now();
    let card: IndexCard | undefined;
    try {
      const events = runtime.run({
        runId: randomUUID(),
        model: context.model,
        instruction: INDEX_INSTRUCTION,
        history: [],
        ask: asked(brief(turn, context)),
        endings: [{ name: INDEX_SHAPE.name, description: INDEX_SHAPE.description, schema: INDEX_SHAPE.schema }],
        maxRounds: 1,
        tools: false,
      });
      for await (const event of events) {
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "done" && event.shape === INDEX_SHAPE.name) {
          const parsed = IndexCard.safeParse(event.answer);
          if (parsed.success) card = parsed.data;
        }
      }
    } catch (error) {
      log(`index: failed (${(error as Error).message}); software's card instead`);
    }
    const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    if (!card) return log(`index ${turn.id.slice(0, 8)}: no card, the default card stays (${took})`);
    const written = ledger.refine(turn, card);
    log(`index ${turn.id.slice(0, 8)}: ${written.kind}, ${written.terms.length} terms, ${written.facts.length} facts, ${took}`);
  }
}

/** Everything the indexing model needs about the exchange, and nothing it does not. */
function brief(turn: TurnRecord, context: IndexContext): string {
  const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { timeZone: context.timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n).trimEnd()}…` : text);
  const lines = [`Now: ${describeNow(new Date(turn.at), context.timeZone)}.`, ""];
  if (context.earlier.length) {
    lines.push("Earlier in this conversation:");
    for (const t of context.earlier.slice(-4)) lines.push(`- Asked: ${clip(t.question, 300)}`, `  Answered: ${clip(t.answerText, 400)}`);
    lines.push("");
  }
  lines.push(
    context.matched.length
      ? `Memory matched the question (${context.confidence} confidence) to: ${context.matched.map((m) => `${date(m.at)}, "${clip(m.question, 160)}"`).join("; ")}.`
      : "Memory matched the question to no earlier exchange.",
    "",
    `The answer was ${turn.shape === "reply" ? "prose" : `a ${turn.shape} card`}.`,
    "",
    `<question>\n${turn.question}\n</question>`,
    "",
    `<answer>\n${turn.shape === "reply" ? turn.lead : turn.answerText}\n</answer>`,
  );
  if (turn.sources.length) {
    lines.push("", "Sources it cited:", ...turn.sources.map((s) => `[${s.id}] ${s.title} (${s.domain}) ${s.url}`));
  }
  return lines.join("\n");
}
