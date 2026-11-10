/**
 * One turn of conversation: the operation every interface (HTTP today, a CLI tomorrow) calls.
 *
 *   recall     memory read before the model is called: what the message points at, by day or topic
 *   the run    the agent runtime (embedded or remote) runs the turn; it reaches this application's
 *              tools only over MCP, sending the run's id so its searches are numbered and kept here
 *   checks     when the run ends, what the application can verify is verified: the answer's shape,
 *              its evidence, its quotes. A problem continues the run once, with the correction
 *   record     the transcript is appended to (never edited), the turn is saved as the person saw it,
 *              and the ledger writes down the facts it stated, after the answer is on screen
 *
 * It decides nothing about the answer. It streams what happens as `TurnEvent`s, which are the
 * screen's vocabulary, not the provider's.
 */
import { randomUUID } from "node:crypto";
import type { Entry } from "../agents/conversation.ts";
import { asked } from "../agents/conversation.ts";
import { Channel } from "../agents/channel.ts";
import { ENDING_PREFIX, type OutputShape } from "../agents/loop.ts";
import type { ModelInfo } from "../agents/ports.ts";
import { applyEdits, Fixes } from "../domain/edits.ts";
import { answerShapes, FIXES_SHAPE, collectRefs, refId, showsNow, type SourceRef } from "../domain/answers.ts";
import { IndexCard, ShapeIndex } from "../domain/card.ts";
import { bareCitations, citationsIn, describeProblems, markUnverified, quoteFound, quoteProblems, repairCitations } from "../domain/quotes.ts";
import type { Activity, Conversation, Source, TurnRecord } from "../domain/memory.ts";
import { answerAsText } from "../domain/render.ts";
import { describeNow } from "../domain/time.ts";
import type { Clock } from "../ports/clock.ts";
import type { MemoryStore } from "../ports/memory.ts";
import type { AgentRuntimePort } from "../ports/runtime.ts";
import type { ModelCatalog } from "./catalog.ts";
import { INSTRUCTION } from "./instruction.ts";
import type { LedgerService } from "./ledger.ts";
import { recheck } from "./recheck.ts";
import type { RecallService } from "./recall.ts";
import { SourceBook } from "./sources.ts";
import { SEARCH_TOOL, type SearchInput, type SearchResult, type SearchService } from "./web-search.ts";

export type TurnEvent =
  | { type: "start"; conversation: Conversation; turnId: string; at: string; model: ModelInfo }
  | { type: "activity"; activity: Activity[] }
  | { type: "sources"; sources: Source[] }
  | { type: "text"; text: string }
  /** The model's reasoning as it streams, when the provider shows it: working, not the answer. */
  | { type: "thinking"; text: string }
  /** The model stopped talking to search; what it said so far was a working note, not the answer. */
  | { type: "searching" }
  /** What was streamed is being redone (a correction, or a tool call written as text): keep it on screen as a draft until the new text arrives. */
  | { type: "revise"; reason: string }
  /** The answer's text is complete and checked; what follows (its index card) is not shown. */
  | { type: "settled"; text: string }
  /** The reply's citations are being corrected in place; the reply stays on screen. */
  | { type: "fixing"; reason: string }
  /** The corrected reply, and the sources whose citations changed, to show where. */
  | { type: "patch"; text: string; fixed: string[] }
  | { type: "shape"; shape: string; partial: unknown }
  | { type: "done"; turn: TurnRecord; cutShort: boolean }
  | { type: "error"; message: string };

export interface TurnInput {
  conversationId?: string;
  message: string;
  modelId?: string;
  timeZone: string;
  signal?: AbortSignal;
}

/** How many times a run is continued to fix what the checks found. */
const MAX_CORRECTIONS = 1;

export class ChatService {
  constructor(
    private readonly deps: {
      store: MemoryStore;
      clock: Clock;
      models: ModelCatalog;
      runtime: AgentRuntimePort;
      search: SearchService;
      recall: RecallService;
      ledger: LedgerService;
      log: (message: string) => void;
    },
  ) {}

  turn(input: TurnInput): AsyncIterable<TurnEvent> {
    const out = new Channel<TurnEvent>();
    this.run(input, out).then(
      () => out.close(),
      (error) => {
        out.push({ type: "error", message: (error as Error).message });
        out.close();
      },
    );
    return out;
  }

  private async run(input: TurnInput, out: Channel<TurnEvent>) {
    const { store, clock, models, runtime, search, recall, ledger, log } = this.deps;
    const message = input.message.trim().slice(0, 8000);
    if (!message) throw new Error("Say something first.");

    const model = await models.pick(input.modelId);
    const now = clock.now();
    const conversation =
      (input.conversationId && store.conversation(input.conversationId)) || store.createConversation(titleFrom(message), now);
    const turnId = randomUUID();
    out.push({ type: "start", conversation, turnId, at: now.toISOString(), model });

    const memory = recall.recall(message, conversation.id, now, input.timeZone);
    const activity: Activity[] = [...memory.activity];
    if (activity.length) out.push({ type: "activity", activity: [...activity] });
    const upsert = (event: Activity) => {
      const same = (a: Activity) =>
        a.kind === "search" && event.kind === "search" && (a.id === event.id || (a.drafting && !event.drafting && a.query === event.query));
      const at = activity.findIndex(same);
      if (at >= 0) activity[at] = event;
      else activity.push(event);
      out.push({ type: "activity", activity: [...activity] });
    };

    // The conversation's sources, built from what the run reports. Earlier turns' carry over, so a
    // follow-up can cite an earlier answer's pages and have its quotes checked.
    const book = new SourceBook({ sources: store.turns(conversation.id).flatMap((t) => t.sources), snapshots: store.snapshotsFor(conversation.id) });
    if (book.sources.length) out.push({ type: "sources", sources: [...book.sources] });

    // When the message most likely points at an earlier answer, re-read the pages its facts came
    // from and diff its quotes, before the model starts (a few seconds at most).
    const prepared = memory.confidence === "high" || memory.confidence === "medium" ? await recheck(memory.baseline, search, book, upsert, input.signal) : "";
    if (book.sources.length) out.push({ type: "sources", sources: [...book.sources] });
    const runId = randomUUID();
    const searches = new Map<string, SearchInput>();

    const shapes = answerShapes(() => book.sources);
    // Sent as data: the checks stay here, where the sources and snapshots are.
    const endings: OutputShape[] = shapes.map(({ name, description, schema }) => ({ name, description, schema }));
    const transcript = store.transcript(conversation.id);
    const ask = asked(message, memory.context + prepared);
    const fresh: Entry[] = [];

    // Slips of form are fixed in software; what still does not hold up is shown marked, never silently.
    const repaired = (text: string) => repairCitations(text, book.snapshots);
    const record = (shape: string, raw: string, answer?: unknown): TurnRecord => {
      const text = repaired(raw);
      return {
      id: turnId,
      conversationId: conversation.id,
      at: now.toISOString(),
      question: message,
      answerText: answerAsText(shape, text, answer),
      // What still does not hold up after a correction is shown marked, never silently.
      lead: markUnverified((answer as { headline?: string } | undefined)?.headline?.trim() ?? text.trim(), book.snapshots),
      shape,
      ...(answer === undefined ? {} : { answer }),
      sources: book.sourcesFor(text, JSON.stringify(answer ?? "")),
      activity,
      model: model.id,
      };
    };

    // Where the time went, one line per turn in the server log.
    const started = Date.now();
    let mark = started, modelMs = 0, toolMs = 0, rounds = 0;
    let spoke = "";
    // A correction continues the run: everything so far becomes its history, the correction its ask.
    let history: Entry[] = transcript;
    let next = ask;
    let corrections = 0;
    // A citation correction comes back as edits to the reply: the reply waits here meanwhile.
    let patching: { shape: string; text: string; answer?: unknown } | undefined;
    let runEndings = endings;
    try {
      while (true) {
        let ended: { shape: string; text: string; answer?: unknown; cutShort: boolean } | undefined;
        const events = runtime.run(
          { runId, model: model.id, instruction: INSTRUCTION, history, ask: next, endings: runEndings },
          input.signal,
        );
        for await (const event of events) {
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "retract") {
            spoke = "";
            out.push({ type: "revise", reason: "Redoing a step" });
          } else if (event.type === "delta") {
            const d = event.delta;
            if (d.type === "text") {
              spoke += d.text;
              // While fixing, the reply on screen stays put; what the model says around its edits is not the answer.
              if (!patching) out.push({ type: "text", text: d.text });
            } else if (d.type === "thinking") {
              out.push({ type: "thinking", text: d.text });
            } else if (d.type === "tool_input" && d.name === SEARCH_TOOL.name) {
              // The query as the model writes it: a lane on screen before the search is even sent.
              const q = (d.partial as { query?: string } | null)?.query;
              if (q) upsert({ kind: "search", id: d.id, query: q, drafting: true });
            } else if (patching) {
              // The fix's own calls (its edits, any search) change nothing on screen until applied.
            } else if (d.name === INDEX_TOOL) {
              // The index card follows the answer and is not shown. The text is complete once it
              // starts: if it holds up, it is the answer now, without waiting for the card.
              if (d.type === "tool_start" && !this.check({ shape: "reply", text: spoke }, shapes, book)) {
                out.push({ type: "settled", text: markUnverified(repaired(spoke), book.snapshots) });
              }
            } else if (d.type === "tool_start") {
              // Whatever was said before a tool call is a note on the way, not the answer.
              spoke = "";
              out.push({ type: "searching" });
            } else if (d.type === "tool_input" && d.name.startsWith(ENDING_PREFIX)) {
              out.push({ type: "shape", shape: d.name.slice(ENDING_PREFIX.length), partial: d.partial });
            }
          } else if (event.type === "entry") {
            fresh.push(event.entry);
            this.observe(event.entry, searches, book, upsert);
            out.push({ type: "sources", sources: [...book.sources] });
            const t = Date.now();
            if (event.entry.kind === "said") (modelMs += t - mark), rounds++;
            if (event.entry.kind === "ran") toolMs += t - mark;
            mark = t;
          } else if (event.type === "done") {
            ended = event;
          }
        }
        if (!ended) throw new Error("The agent runtime stopped without an answer.");

        if (patching) {
          const fix = ended.shape === FIXES_SHAPE.name ? Fixes.safeParse(ended.answer) : undefined;
          if (fix?.success) {
            const { text, applied, missed } = applyEdits(patching.text, fix.data.edits);
            log(`fixes: ${applied.length} applied, ${missed.length} missed`);
            out.push({
              type: "patch",
              text: markUnverified(repaired(text), book.snapshots),
              fixed: [...new Set(citationsIn(applied.map((e) => e.replace).join(" ")).map((c) => c.id))],
            });
            ended = { ...patching, text, cutShort: ended.cutShort };
          } else if (ended.shape === "reply" && ended.text.trim()) {
            // It wrote the reply out again after all: shown as a revision, the card from the first one kept.
            out.push({ type: "revise", reason: "Rewriting" });
            out.push({ type: "text", text: ended.text });
            ended = { ...patching, text: ended.text, cutShort: ended.cutShort };
          } else {
            ended = { ...patching, cutShort: ended.cutShort };
          }
          patching = undefined;
        }

        const problem = this.check(ended, shapes, book);
        if (problem && corrections++ < MAX_CORRECTIONS) {
          log(`correction: ${problem.split("\n").slice(0, 3).join(" ").slice(0, 300)}`);
          // Continue the run with the correction: the model sees what it said and why it was sent back.
          history = [...transcript, ask, ...fresh];
          const prose = ended.shape === "reply" || ended.shape === "index";
          if (prose && problem.startsWith("Some citations")) {
            // Fixed in place: the model sends edits, the rest of the reply stands as written.
            patching = { shape: ended.shape, text: ended.text, answer: ended.answer };
            runEndings = [{ name: FIXES_SHAPE.name, description: FIXES_SHAPE.description, schema: FIXES_SHAPE.schema }];
            next = asked(`${problem}\nFix only these, in place, with answer_fixes. Search first if you need a source that says it.`, undefined, "runtime");
            const n = problem.split("\n").filter((l) => l.startsWith("- ")).length;
            out.push({ type: "fixing", reason: `Fixing ${n} citation${n === 1 ? "" : "s"}` });
          } else {
            runEndings = endings;
            next = asked(problem, undefined, "runtime");
            out.push({ type: "revise", reason: "Rewording" });
          }
          fresh.push(next);
          spoke = "";
          continue;
        }

        // A prose answer ends with its index card; a structured one carries the card inside it.
        const prose = ended.shape === "reply" || ended.shape === "index";
        const written = cardOf(prose ? ended.answer : (ended.answer as { index?: unknown } | undefined)?.index);
        const answer = prose ? undefined : markCardQuotes(parsed(shapes, ended) ?? ended.answer, book.snapshots, book.sources);
        const turn = record(prose ? "reply" : ended.shape, ended.text, answer);
        store.append(conversation.id, settledExchange(message, now, input.timeZone, turn.shape === "reply" ? repaired(ended.text) : turn.answerText));
        store.saveTurn(turn);
        store.saveSnapshots(turn, book.snapshots);
        store.touch(conversation.id, clock.now());
        out.push({ type: "done", turn, cutShort: ended.cutShort });
        const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
        log(
          `turn ${turn.id.slice(0, 8)} ${model.label}${prepared ? " (re-checked quotes)" : ""}: ${rounds} model rounds ${s(modelMs)}, ` +
            `${book.sources.length} sources ${s(toolMs)} in tools, total ${s(Date.now() - started)}, ${turn.shape}`,
        );
        const card = ledger.record(turn, written);
        log(`ledger: ${written ? "card" : "fallback card"}, ${card.kind}, ${card.terms.length} terms, ${card.facts.length} facts`);
        return;
      }
    } catch (error) {
      // The transcript must stay a valid conversation for the next turn: keep the question and
      // close it with what was said, rather than leaving a half-finished tool round behind.
      const stopped = input.signal?.aborted;
      const text = spoke.trim() || (stopped ? "(stopped)" : "(something went wrong before I could answer)");
      store.append(conversation.id, settledExchange(message, now, input.timeZone, text));
      store.saveTurn(record("reply", text));
      store.touch(conversation.id, clock.now());
      if (!stopped) throw error;
    }
  }

  /**
   * What a run entry means for the screen and the sources: a search asked for opens a lane; its
   * results come back through the runtime with the search service's structured data, and are
   * entered in the conversation's sources.
   */
  private observe(entry: Entry, searches: Map<string, SearchInput>, book: SourceBook, upsert: (a: Activity) => void) {
    if (entry.kind === "said") {
      for (const call of entry.toolCalls) {
        if (call.name !== SEARCH_TOOL.name) continue;
        const args = call.arguments as SearchInput;
        searches.set(call.id, args);
        upsert({ kind: "search", id: call.id, query: laneLabel(args), since: args.since, domains: args.domains, fresh: args.fresh });
      }
    } else if (entry.kind === "ran") {
      for (const result of entry.results) {
        const args = searches.get(result.callId);
        if (!args) continue;
        const lane: Activity = { kind: "search", id: result.callId, query: laneLabel(args), since: args.since, domains: args.domains, fresh: args.fresh };
        if (result.failed) {
          upsert({ ...lane, failed: result.content.replace(/^Search failed:\s*/, "").slice(0, 200) });
          continue;
        }
        const data = result.data as { results?: SearchResult[]; cached?: boolean } | undefined;
        const ids = book.enter(data?.results ?? [], args);
        upsert({ ...lane, results: ids.length, hits: ids, ...(data?.cached ? { reused: true } : {}) });
      }
    }
  }

  /**
   * What the application can verify about an answer, and the correction if it does not hold:
   * a shape's schema and evidence; a reply's citations (proportionate: a citation standing in for
   * the fact, a malformed one or an unknown source always; quote misses only beyond two).
   */
  private check(ended: { shape: string; text: string; answer?: unknown }, shapes: OutputShape[], book: SourceBook): string | null {
    // The index card is metadata: a bad one falls back to software's card, never costs a rewrite.
    if (ended.shape !== "reply" && ended.shape !== "index") {
      const shape = shapes.find((s) => s.name === ended.shape);
      const result = shape?.parse?.(ended.answer);
      return result && !result.ok ? `Your answer_${ended.shape} call did not hold up: ${result.error}` : null;
    }
    // The mechanism is not the person's business: "the context shows…" goes back to be said plainly.
    const leak = MECHANISM.find((m) => ended.text.toLowerCase().includes(m));
    if (leak) return `Your reply mentions "${leak}". Speak as someone who remembers (or does not), never about context, memory or calendars as a mechanism. Give the whole answer again.`;
    const text = repairCitations(ended.text, book.snapshots);
    const misses = quoteProblems(citationsIn(text), book.snapshots);
    // Only what software cannot fix goes back: a source that was never found, a citation standing in for the fact.
    const structural = [...misses.filter((p) => p.reason === "unknown source"), ...bareCitations(text)];
    const quoteMisses = misses.filter((p) => p.reason !== "unknown source");
    const problems = structural.length || quoteMisses.length > 2 ? [...structural, ...quoteMisses] : [];
    return problems.length ? describeProblems(problems) : null;
  }
}

const INDEX_TOOL = `${ENDING_PREFIX}index`;
const laneLabel = (args: SearchInput) => args.query ?? `Reading back ${args.pages?.join(", ") ?? "pages"}`;

/**
 * What later turns replay of this one: the question, with when it was asked, and the answer as
 * given, its citations still tagged. Pages, searches and recalled context stay out: they were
 * this turn's working, and an answer stands on its citations. If a later turn needs more of a page
 * than the quote, the model reads it back by id (web_search `pages`), from the snapshot kept
 * here. A boundary the answers follow, inspectable when wanted, and a replay that stays small.
 */
function settledExchange(message: string, at: Date, tz: string, answer: string): Entry[] {
  return [
    asked(message, `<context written-by="system">Asked ${describeNow(at, tz)}.</context>`),
    { kind: "said", text: answer, toolCalls: [], stopReason: "end_turn" },
  ];
}
/** Words that only describe how the agent works, never what it knows. */
const MECHANISM = ["the context", "my context", "context block", "context i have", "my memory shows", "memory shows", "the calendar shows", "according to my memory", "<context", "<rechecked"];

/** The model's index card, if it wrote a valid one (a prose answer's, or a structured answer's without facts). */
function cardOf(value: unknown): IndexCard | undefined {
  const full = IndexCard.safeParse(value);
  if (full.success) return full.data;
  const light = ShapeIndex.safeParse(value);
  return light.success ? { ...light.data, facts: [] } : undefined;
}

/** The shape's own reading of its arguments (defaults filled, unknown fields dropped), if it has one. */
function parsed(shapes: OutputShape[], ended: { shape: string; answer?: unknown }): unknown {
  const result = shapes.find((s) => s.name === ended.shape)?.parse?.(ended.answer);
  return result?.ok ? result.value : undefined;
}

function titleFrom(message: string): string {
  const line = message.split("\n")[0].trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/**
 * Flags each quoted source entry in a card as verified or not, for the screen. And a verdict with
 * nothing behind it is unverified by definition: "unchanged" citing no source is shown as such.
 */
function markCardQuotes(answer: unknown, snapshots: ReadonlyMap<string, string>, sources: Source[]): unknown {
  const card = answer as { since?: string; items?: { subject: string; status: string; sources: SourceRef[]; note?: string }[] } | undefined;
  for (const item of card?.items ?? []) {
    // "Unchanged" is a claim about now too: with nothing current behind it, it is unverified.
    const current = item.sources.some((ref) => {
      const source = sources.find((s) => s.id === refId(ref));
      return !!source && !!card?.since && showsNow(item.subject, source, card.since);
    });
    if (item.status === "unchanged" && !current) {
      item.status = "unverified";
      item.note = item.note ? `${item.note} (nothing current re-read it)` : "Nothing current re-read this.";
    }
  }
  for (const ref of collectRefs(answer)) {
    if (typeof ref === "string") continue;
    const snapshot = snapshots.get(ref.id);
    ref.verified = snapshot !== undefined && quoteFound(ref.quote, snapshot);
  }
  return answer;
}
