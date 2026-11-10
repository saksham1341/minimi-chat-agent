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
import { attachCitations } from "../domain/citations.ts";
import { answerShapes, collectRefs, refId, showsNow, type SourceRef } from "../domain/answers.ts";
import { citationsIn, markUnverified, quoteFound, repairCitations } from "../domain/quotes.ts";
import type { Activity, Conversation, Source, TurnRecord } from "../domain/memory.ts";
import { answerAsText } from "../domain/render.ts";
import { describeNow } from "../domain/time.ts";
import type { Clock } from "../ports/clock.ts";
import type { MemoryStore } from "../ports/memory.ts";
import type { AgentRuntimePort } from "../ports/runtime.ts";
import type { ModelCatalog } from "./catalog.ts";
import { INSTRUCTION } from "./instruction.ts";
import type { Citer, CiteSession, Page } from "./citer.ts";
import type { Planner } from "./planner.ts";
import type { Indexer } from "./indexer.ts";
import type { LedgerService } from "./ledger.ts";
import { recheck } from "./recheck.ts";
import type { Recollection, RecallService } from "./recall.ts";
import { SourceBook } from "./sources.ts";
import { formatResults, SEARCH_TOOL, type SearchInput, type SearchResult, type SearchService } from "./web-search.ts";

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
  /** The corrected reply, and the sources whose citations changed, to show where. */
  | { type: "patch"; text: string; fixed: string[] }
  /** A message sent while this turn was working has joined it, after a round of searches. */
  | { type: "joined"; id: string; text: string }
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
/** How long, after the answer is written, its citations may take to arrive. */
const CITE_DEADLINE_MS = 20_000;

export class ChatService {
  /**
   * Each turn in progress: its run once started, so a message sent meanwhile can be said to it, and
   * what was said before the run started (while memory was read and pages re-read), which joins
   * the opening question instead.
   */
  private readonly active = new Map<string, { runId?: string; early: { id: string; text: string }[] }>();

  constructor(
    private readonly deps: {
      store: MemoryStore;
      clock: Clock;
      models: ModelCatalog;
      runtime: AgentRuntimePort;
      search: SearchService;
      recall: RecallService;
      ledger: LedgerService;
      /** Plans and runs the message's searches before the answer starts. Without one, the answering model searches itself. */
      planner?: Planner;
      /** Finds the answer's citations while it is written. Without one, the answer's page tags stand alone. */
      citer?: Citer;
      /** Writes each turn's index card in the background. Without one, software's card is written at once. */
      indexer?: Indexer;
      log: (message: string) => void;
    },
  ) {}

  /**
   * Say something to a turn that is still working. The runtime takes it up at the run's next seam
   * (after a round of searches), and the turn streams `joined` when it does. Null when the turn has
   * finished, or is past its last search: then it is the next turn's question instead.
   */
  async say(turnId: string, text: string): Promise<{ id: string } | null> {
    const turn = this.active.get(turnId);
    const message = text.trim().slice(0, 8000);
    if (!turn || !message) return null;
    if (turn.runId) return this.deps.runtime.say(turn.runId, message);
    const early = { id: randomUUID(), text: message };
    turn.early.push(early);
    return { id: early.id };
  }

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
    const { store, clock, models, runtime, search, recall, ledger, indexer, citer, log } = this.deps;
    const message = input.message.trim().slice(0, 8000);
    if (!message) throw new Error("Say something first.");

    const model = await models.pick(input.modelId);
    // The light model does the work around the answer: citations, the index card.
    const light = await models.light();
    const now = clock.now();
    const conversation =
      (input.conversationId && store.conversation(input.conversationId)) || store.createConversation(titleFrom(message), now);
    const turnId = randomUUID();
    const live: { runId?: string; early: { id: string; text: string }[] } = { early: [] };
    this.active.set(turnId, live);
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
    // Meanwhile, the searches the message needs are planned by the light model and run in parallel,
    // so the answering model starts with results in hand rather than spending a round asking.
    const [rechecked, searched] = await Promise.all([
      memory.confidence === "high" || memory.confidence === "medium" ? recheck(memory.baseline, search, book, upsert, input.signal) : Promise.resolve(""),
      this.fanOut(message, conversation.id, memory, light, now, input.timeZone, book, upsert, input.signal),
    ]);
    const prepared = rechecked + searched;
    if (book.sources.length) out.push({ type: "sources", sources: [...book.sources] });
    const runId = randomUUID();
    // Messages that joined this turn while it worked: part of its question, as the model saw them.
    // Those said before the run started are simply part of the opening question.
    const joined: string[] = [];
    let dequeued: string | undefined;
    const question = () => [message, ...joined].join("\n\n");
    for (const early of live.early.splice(0)) {
      joined.push(early.text);
      out.push({ type: "joined", id: early.id, text: early.text });
    }
    live.runId = runId;
    const searches = new Map<string, SearchInput>();

    const shapes = answerShapes(() => book.sources);
    // Sent as data: the checks stay here, where the sources and snapshots are.
    const endings: OutputShape[] = shapes.map(({ name, description, schema }) => ({ name, description, schema }));
    const transcript = store.transcript(conversation.id);
    const ask = asked(question(), memory.context + prepared);
    const fresh: Entry[] = [];

    // Slips of form are fixed in software; what still does not hold up is shown marked, never silently.
    const repaired = (text: string) => repairCitations(text, book.snapshots);
    const record = (shape: string, raw: string, answer?: unknown): TurnRecord => {
      const text = repaired(raw);
      return {
      id: turnId,
      conversationId: conversation.id,
      at: now.toISOString(),
      question: question(),
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
    // Citations are found by a second run while the answer is written (`services/citer.ts`): it is
    // fed each paragraph as it completes, and what it finds is attached on screen behind the text.
    let cite: CiteSession | undefined;
    let fed = 0;
    let shown = 0;
    const pagesOf = (ids: Iterable<string>): Page[] =>
      [...new Set(ids)].flatMap((id) => {
        const source = book.sources.find((x) => x.id === id);
        const text = book.snapshots.get(id);
        return source && text ? [{ id, title: source.title, domain: source.domain, text }] : [];
      });
    const tagged = (text: string) => citationsIn(text).map((c) => c.id);
    const feed = (final: boolean) => {
      if (!citer) return;
      while (fed < spoke.length) {
        const cut = final ? spoke.length : spoke.indexOf("\n\n", fed);
        if (cut < 0) return;
        const part = spoke.slice(fed, cut).trim();
        fed = final ? spoke.length : cut + 2;
        if (!part) continue;
        if (!cite) {
          shown = 0;
          cite = citer.begin({
            model: light,
            question: question(),
            onFound: (found) => {
              const fixed = [...new Set(found.slice(shown).flatMap((f) => f.sources.map((x) => x.id)))];
              shown = found.length;
              out.push({ type: "patch", text: markUnverified(repaired(attachCitations(spoke, found)), book.snapshots), fixed });
            },
          });
        }
        // Exactly what the answering model read for the pages this paragraph tags.
        cite.push(part, pagesOf(tagged(part)));
      }
    };
    const dropCitations = () => {
      cite?.abort();
      cite = undefined;
      fed = 0;
    };
    try {
      while (true) {
        let ended: { shape: string; text: string; answer?: unknown; cutShort: boolean } | undefined;
        const events = runtime.run(
          { runId, model: model.id, instruction: INSTRUCTION, history, ask: next, endings },
          input.signal,
        );
        for await (const event of events) {
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "dequeued") dequeued = event.id;
          if (event.type === "entry" && event.entry.kind === "asked" && event.entry.by === "user" && dequeued) {
            joined.push(event.entry.text);
            out.push({ type: "joined", id: dequeued, text: event.entry.text });
            dequeued = undefined;
          }
          if (event.type === "retract") {
            spoke = "";
            dropCitations();
            out.push({ type: "revise", reason: "Redoing a step" });
          } else if (event.type === "delta") {
            const d = event.delta;
            if (d.type === "text") {
              spoke += d.text;
              out.push({ type: "text", text: d.text });
              feed(false);
            } else if (d.type === "thinking") {
              out.push({ type: "thinking", text: d.text });
            } else if (d.type === "tool_input" && d.name === SEARCH_TOOL.name) {
              // The query as the model writes it: a lane on screen before the search is even sent.
              const q = (d.partial as { query?: string } | null)?.query;
              if (q) upsert({ kind: "search", id: d.id, query: q, drafting: true });
            } else if (d.type === "tool_start") {
              // Whatever was said before a tool call is a note on the way, not the answer.
              spoke = "";
              dropCitations();
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

        // The answer is written: its last paragraph goes to the citation runs, which finish after
        // the answer is done (the person does not wait for them).
        let citing: CiteSession | undefined;
        if (ended.shape === "reply") {
          feed(true);
          citing = cite;
          cite = undefined;
          fed = 0;
        }

        const problem = this.check(ended, shapes);
        if (problem && corrections++ < MAX_CORRECTIONS) {
          log(`correction: ${problem.split("\n").slice(0, 3).join(" ").slice(0, 300)}`);
          // Continue the run with the correction: the model sees what it said and why it was sent back.
          history = [...transcript, ask, ...fresh];
          citing?.abort();
          next = asked(problem, undefined, "runtime");
          out.push({ type: "revise", reason: "Rewording" });
          fresh.push(next);
          spoke = "";
          continue;
        }

        const prose = ended.shape === "reply";
        const answer = prose ? undefined : markCardQuotes(parsed(shapes, ended) ?? ended.answer, book.snapshots, book.sources);
        const turn = record(prose ? "reply" : ended.shape, ended.text, answer);
        store.append(conversation.id, settledExchange(question(), now, input.timeZone, turn.shape === "reply" ? repaired(ended.text) : turn.answerText));
        store.saveTurn(turn);
        store.saveSnapshots(turn, book.snapshots);
        store.touch(conversation.id, clock.now());
        out.push({ type: "done", turn, cutShort: ended.cutShort });
        const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
        log(
          `turn ${turn.id.slice(0, 8)} ${model.label}${rechecked ? " (re-checked quotes)" : ""}${searched ? " (searches planned)" : ""}: ${rounds} model rounds ${s(modelMs)}, ` +
            `${book.sources.length} sources ${s(toolMs)} in tools, total ${s(Date.now() - started)}, ${turn.shape}`,
        );
        // The person has the answer. Its citations land now, and the saved turn takes them.
        let final = turn;
        if (citing?.parts) {
          const found = await citing.finish(CITE_DEADLINE_MS);
          if (found.length) {
            final = record("reply", attachCitations(ended.text, found));
            store.updateTurn(final);
            store.saveSnapshots(final, book.snapshots);
            out.push({ type: "patch", text: final.lead, fixed: [] });
          }
        }
        // A default card now, from the topics the answer marked; the indexer's run replaces it in
        // the background, with the context a full card needs.
        const earlier = store.turns(conversation.id).filter((t) => t.id !== final.id);
        const matched = memory.activity.flatMap((a) => (a.kind === "memory" ? a.exchanges : []));
        ledger.record(final);
        if (indexer) void indexer.index(final, { model: light, earlier, matched, confidence: memory.confidence, timeZone: input.timeZone });
        return;
      }
    } catch (error) {
      // The transcript must stay a valid conversation for the next turn: keep the question and
      // close it with what was said, rather than leaving a half-finished tool round behind.
      const stopped = input.signal?.aborted;
      const text = spoke.trim() || (stopped ? "(stopped)" : "(something went wrong before I could answer)");
      store.append(conversation.id, settledExchange(question(), now, input.timeZone, text));
      store.saveTurn(record("reply", text));
      store.touch(conversation.id, clock.now());
      if (!stopped) throw error;
    } finally {
      this.active.delete(turnId);
    }
  }

  /**
   * Plans the message's searches with the light model and runs them all at once. Their results are
   * entered like any search's (sources, snapshots, lanes on screen) and handed to the answering
   * model in a <searched> block, in the same form its own searches return.
   */
  private async fanOut(
    message: string,
    conversationId: string,
    memory: Recollection,
    light: string,
    now: Date,
    tz: string,
    book: SourceBook,
    upsert: (a: Activity) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const { planner, search, store } = this.deps;
    if (!planner || !search.available) return "";
    const last = store.turns(conversationId).at(-1);
    const matched = memory.activity.flatMap((a) => (a.kind === "memory" ? a.exchanges : []));
    const context = [
      `Now: ${describeNow(now, tz)}.`,
      ...(last ? [`Earlier in this conversation they asked: ${last.question.slice(0, 300)}`, `and were answered: ${last.answerText.slice(0, 500)}`] : []),
      ...(matched.length ? [`Memory matched the message (${memory.confidence} confidence) to earlier questions: ${matched.map((m) => `"${m.question.slice(0, 160)}"`).join("; ")}`] : []),
    ].join("\n");
    const plan = await planner.plan({ model: light, message, context });
    if (!plan.length || signal?.aborted) return "";
    const blocks = await Promise.all(
      plan.map(async (args, i) => {
        const lane: Activity = { kind: "search", id: `plan-${i}`, query: args.query ?? "", since: args.since, domains: args.domains, fresh: args.fresh };
        upsert(lane);
        try {
          const found = await search.search(args, signal);
          const ids = book.enter(found.results, args);
          upsert({ ...lane, results: ids.length, hits: ids, ...(found.cached ? { reused: true } : {}) });
          return `Search: ${args.query}${args.domains?.length ? ` (on ${args.domains.join(", ")})` : ""}\n${formatResults(found.results, args.since)}`;
        } catch (error) {
          upsert({ ...lane, failed: (error as Error).message.slice(0, 200) });
          return `Search: ${args.query}\nFailed: ${(error as Error).message.slice(0, 200)}`;
        }
      }),
    );
    return `\n\n<searched written-by="system">\nSearches run for this message before you started, with their results:\n\n${blocks.join("\n\n")}\n</searched>`;
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
  private check(ended: { shape: string; text: string; answer?: unknown }, shapes: OutputShape[]): string | null {
    if (ended.shape !== "reply") {
      const shape = shapes.find((s) => s.name === ended.shape);
      const result = shape?.parse?.(ended.answer);
      return result && !result.ok ? `Your answer_${ended.shape} call did not hold up: ${result.error}` : null;
    }
    // The mechanism is not the person's business: "the context shows…" goes back to be said plainly.
    // Citations never send an answer back: the citation run attaches them, and a quote that does
    // not hold up is shown as unverified.
    const leak = MECHANISM.find((m) => ended.text.toLowerCase().includes(m));
    return leak ? `Your reply mentions "${leak}". Speak as someone who remembers (or does not), never about context, memory or calendars as a mechanism. Give the whole answer again.` : null;
  }
}

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
