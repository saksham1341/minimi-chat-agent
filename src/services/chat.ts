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
import { answerShapes, collectRefs, refId, showsNow, type SourceRef } from "../domain/answers.ts";
import { bareCitations, citationsIn, describeProblems, malformedCitations, markUnverified, quoteFound, quoteProblems } from "../domain/quotes.ts";
import type { Activity, Conversation, Source, TurnRecord } from "../domain/memory.ts";
import { answerAsText } from "../domain/render.ts";
import { planReadAhead } from "../domain/recheck.ts";
import type { Clock } from "../ports/clock.ts";
import type { MemoryStore } from "../ports/memory.ts";
import type { AgentRuntimePort } from "../ports/runtime.ts";
import type { ModelCatalog } from "./catalog.ts";
import { INSTRUCTION } from "./instruction.ts";
import type { LedgerService } from "./ledger.ts";
import { ReadAhead } from "./read-ahead.ts";
import type { RecallService } from "./recall.ts";
import type { RunRegistry } from "./runs.ts";
import { CitedSearch, SEARCH_TOOL, type SearchService } from "./web-search.ts";

export type TurnEvent =
  | { type: "start"; conversation: Conversation; turnId: string; at: string; model: ModelInfo }
  | { type: "activity"; activity: Activity[] }
  | { type: "sources"; sources: Source[] }
  | { type: "text"; text: string }
  /** The model stopped talking to search; what it said so far was a note, not the answer. */
  | { type: "searching" }
  /** Discard the text streamed this round: it was not an answer. */
  | { type: "retract" }
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
      runs: RunRegistry;
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
    const { store, clock, models, runtime, search, runs, recall, ledger, log } = this.deps;
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

    // Reads a re-check would need start now, in the background, beside the model's first request.
    // The model decides whether to use them.
    const readAhead = memory.readAhead.length ? new ReadAhead(search, upsert) : undefined;
    readAhead?.start(planReadAhead(memory.readAhead), input.signal);

    // This run's searches, kept here and found by the run's id when the runtime calls over MCP.
    // Sources carry across the conversation, so a follow-up can cite an earlier answer's pages.
    const prior = { sources: store.turns(conversation.id).flatMap((t) => t.sources), snapshots: store.snapshotsFor(conversation.id) };
    const cited = new CitedSearch(
      search,
      (event, sources) => {
        upsert(event);
        out.push({ type: "sources", sources: [...sources] });
      },
      { readAhead, prior },
    );
    if (prior.sources.length) out.push({ type: "sources", sources: [...cited.sources] });
    const runId = randomUUID();
    runs.open(runId, cited);

    const shapes = answerShapes(() => cited.sources);
    // Sent as data: the checks stay here, where the sources and snapshots are.
    const endings: OutputShape[] = shapes.map(({ name, description, schema }) => ({ name, description, schema }));
    const transcript = store.transcript(conversation.id);
    const ask = asked(message, memory.context);
    const fresh: Entry[] = [];

    const record = (shape: string, text: string, answer?: unknown): TurnRecord => ({
      id: turnId,
      conversationId: conversation.id,
      at: now.toISOString(),
      question: message,
      answerText: answerAsText(shape, text, answer),
      // What still does not hold up after a correction is shown marked, never silently.
      lead: markUnverified((answer as { headline?: string } | undefined)?.headline?.trim() ?? text.trim(), cited.snapshots),
      shape,
      ...(answer === undefined ? {} : { answer }),
      sources: cited.sourcesFor(text, JSON.stringify(answer ?? "")),
      activity,
      model: model.id,
    });

    // Where the time went, one line per turn in the server log.
    const started = Date.now();
    let mark = started, modelMs = 0, toolMs = 0, rounds = 0;
    let spoke = "";
    // A correction continues the run: everything so far becomes its history, the correction its ask.
    let history: Entry[] = transcript;
    let next = ask;
    let corrections = 0;
    try {
      while (true) {
        let ended: { shape: string; text: string; answer?: unknown; cutShort: boolean } | undefined;
        const events = runtime.run(
          { runId, model: model.id, instruction: INSTRUCTION, history, ask: next, endings },
          input.signal,
        );
        for await (const event of events) {
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "retract") {
            spoke = "";
            out.push({ type: "retract" });
          } else if (event.type === "delta") {
            const d = event.delta;
            if (d.type === "text") {
              spoke += d.text;
              out.push({ type: "text", text: d.text });
            } else if (d.type === "tool_input" && d.name === SEARCH_TOOL.name) {
              // The query as the model writes it: a lane on screen before the search is even sent.
              const q = (d.partial as { query?: string } | null)?.query;
              if (q) upsert({ kind: "search", id: d.id, query: q, drafting: true });
            } else if (d.type === "tool_start") {
              // Whatever was said before a tool call is a note on the way, not the answer.
              spoke = "";
              out.push({ type: "searching" });
            } else if (d.type === "tool_input" && d.name.startsWith(ENDING_PREFIX)) {
              out.push({ type: "shape", shape: d.name.slice(ENDING_PREFIX.length), partial: d.partial });
            }
          } else if (event.type === "entry") {
            fresh.push(event.entry);
            const t = Date.now();
            if (event.entry.kind === "said") (modelMs += t - mark), rounds++;
            if (event.entry.kind === "ran") toolMs += t - mark;
            mark = t;
          } else if (event.type === "done") {
            ended = event;
          }
        }
        if (!ended) throw new Error("The agent runtime stopped without an answer.");

        const problem = this.check(ended, shapes, cited);
        if (problem && corrections++ < MAX_CORRECTIONS) {
          // Continue the run with the correction: the model sees what it said and why it was sent back.
          history = [...transcript, ask, ...fresh];
          next = asked(problem, undefined, "runtime");
          fresh.push(next);
          out.push({ type: "retract" });
          spoke = "";
          continue;
        }

        const answer = ended.shape === "reply" ? undefined : markCardQuotes(parsed(shapes, ended) ?? ended.answer, cited.snapshots, cited.sources);
        const turn = record(ended.shape, ended.text, answer);
        store.append(conversation.id, [ask, ...fresh]);
        store.saveTurn(turn);
        store.saveSnapshots(turn, cited.snapshots);
        store.touch(conversation.id, clock.now());
        out.push({ type: "done", turn, cutShort: ended.cutShort });
        const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
        log(
          `turn ${turn.id.slice(0, 8)} ${model.label}${readAhead ? " (read ahead)" : ""}: ${rounds} model rounds ${s(modelMs)}, ` +
            `${cited.sources.length} sources ${s(toolMs)} in tools, total ${s(Date.now() - started)}, ${turn.shape}`,
        );
        ledger.record(turn).then(
          (n) => n && log(`ledger: ${n} claim${n === 1 ? "" : "s"} recorded for turn ${turn.id}`),
          (error) => log(`ledger: ${(error as Error).message}`),
        );
        return;
      }
    } catch (error) {
      // The transcript must stay a valid conversation for the next turn: keep the question and
      // close it with what was said, rather than leaving a half-finished tool round behind.
      const stopped = input.signal?.aborted;
      const text = spoke.trim() || (stopped ? "(stopped)" : "(something went wrong before I could answer)");
      store.append(conversation.id, [ask, { kind: "said", text, toolCalls: [], stopReason: stopped ? "stopped" : "error" }]);
      store.saveTurn(record("reply", text));
      store.touch(conversation.id, clock.now());
      if (!stopped) throw error;
    } finally {
      runs.close(runId);
    }
  }

  /**
   * What the application can verify about an answer, and the correction if it does not hold:
   * a shape's schema and evidence; a reply's citations (proportionate: a citation standing in for
   * the fact, a malformed one or an unknown source always; quote misses only beyond two).
   */
  private check(ended: { shape: string; text: string; answer?: unknown }, shapes: OutputShape[], cited: CitedSearch): string | null {
    if (ended.shape !== "reply") {
      const shape = shapes.find((s) => s.name === ended.shape);
      const result = shape?.parse?.(ended.answer);
      return result && !result.ok ? `Your answer_${ended.shape} call did not hold up: ${result.error}` : null;
    }
    const misses = quoteProblems(citationsIn(ended.text), cited.snapshots);
    const structural = [...misses.filter((p) => p.reason === "unknown source"), ...malformedCitations(ended.text), ...bareCitations(ended.text)];
    const quoteMisses = misses.filter((p) => p.reason !== "unknown source");
    const problems = structural.length || quoteMisses.length > 2 ? [...structural, ...quoteMisses] : [];
    return problems.length ? describeProblems(problems) : null;
  }
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
