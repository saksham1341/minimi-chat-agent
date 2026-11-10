/**
 * One turn of conversation: the operation every interface (HTTP today, a CLI tomorrow) calls.
 *
 *   recall     dates resolved and memory read, in milliseconds, before the model is called
 *   the loop   the model (the driver) searches and answers; this service only carries it out
 *   record     the transcript is appended to (never edited), the turn is saved as the person saw it
 *   ledger     the facts the answer stated are written down, after the answer is already on screen
 *
 * It decides nothing about the answer. It streams what happens as `TurnEvent`s, which are the
 * screen's vocabulary, not the provider's.
 */
import { randomUUID } from "node:crypto";
import type { Entry } from "../agents/conversation.ts";
import { asked } from "../agents/conversation.ts";
import { Channel } from "../agents/channel.ts";
import { ENDING_PREFIX, stream } from "../agents/loop.ts";
import type { ModelInfo } from "../agents/ports.ts";
import { answerShapes, collectRefs } from "../domain/answers.ts";
import { bareCitations, citationsIn, describeProblems, malformedCitations, markUnverified, quoteFound, quoteProblems } from "../domain/quotes.ts";
import type { Activity, Conversation, Source, TurnRecord } from "../domain/memory.ts";
import { answerAsText } from "../domain/render.ts";
import type { Clock } from "../ports/clock.ts";
import type { MemoryStore } from "../ports/memory.ts";
import type { ToolSurface } from "../agents/ports.ts";
import type { ModelCatalog } from "./catalog.ts";
import { INSTRUCTION } from "./instruction.ts";
import type { LedgerService } from "./ledger.ts";
import type { RecallService } from "./recall.ts";
import { CitedSearch, SEARCH_TOOL } from "./web-search.ts";
import { planRechecks } from "../domain/recheck.ts";

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

export class ChatService {
  constructor(
    private readonly deps: {
      store: MemoryStore;
      clock: Clock;
      models: ModelCatalog;
      /** The runtime's tools: over MCP in production, anything satisfying the port in tests. */
      tools: ToolSurface;
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
    const { store, clock, models, tools, recall, ledger, log } = this.deps;
    const message = input.message.trim().slice(0, 8000);
    if (!message) throw new Error("Say something first.");

    const model = models.pick(input.modelId);
    const now = clock.now();
    const conversation =
      (input.conversationId && store.conversation(input.conversationId)) || store.createConversation(titleFrom(message), now);
    const turnId = randomUUID();
    out.push({ type: "start", conversation, turnId, at: now.toISOString(), model: model.info });

    const memory = recall.recall(message, conversation.id, now, input.timeZone);
    const activity: Activity[] = [...memory.activity];
    if (activity.length) out.push({ type: "activity", activity: [...activity] });

    const tool = new CitedSearch(tools, (event, sources) => {
      const at = activity.findIndex((a) => a.kind === "search" && event.kind === "search" && a.id === event.id);
      if (at >= 0) activity[at] = event;
      else activity.push(event);
      out.push({ type: "activity", activity: [...activity] });
      out.push({ type: "sources", sources: [...sources] });
    });

    // A re-check starts with the pages the stated facts came from already re-read: planned from the
    // ledger, fired in parallel through the same tool path, before the model's first token.
    let context = memory.context;
    let prefetched = false;
    if (memory.recheck) {
      const plan = planRechecks(memory.claims);
      const reads = await Promise.all(plan.map((args, i) => tool.run({ id: `recheck-${i}`, name: SEARCH_TOOL.name, arguments: { ...args } }, input.signal)));
      const done = plan.map((p, i) => ({ p, r: reads[i] })).filter(({ r }) => !r.failed);
      if (done.length) {
        prefetched = true;
        const ran = done.map(({ p }) => `- "${p.query}"${p.domains ? ` on ${p.domains.join(", ")}, read live` : ""}${p.since ? ` since ${p.since}` : ""}`);
        context +=
          `\n\n<rechecked written-by="system">\nThese searches were already run for this re-check, just now:\n${ran.join("\n")}\n` +
          `Running them again, or rewordings of them, returns the same pages. Answer from these results. Search again only ` +
          `for a specific gap they leave (a vendor page that came back empty, say), at most once.\n\n` +
          `${done.map(({ r }) => r.content).join("\n\n")}\n</rechecked>`;
      }
    }
    const ask = asked(message, context);
    const fresh: Entry[] = [];
    const record = (shape: string, text: string, answer?: unknown): TurnRecord => ({
      id: turnId,
      conversationId: conversation.id,
      at: now.toISOString(),
      question: message,
      answerText: answerAsText(shape, text, answer),
      // What still does not hold up after the retry is shown marked, never silently.
      lead: markUnverified((answer as { headline?: string } | undefined)?.headline?.trim() ?? text.trim(), tool.snapshots),
      shape,
      ...(answer === undefined ? {} : { answer }),
      sources: tool.sources,
      activity,
      model: model.info.id,
    });

    let spoke = "";
    // Where the time went, one line per turn in the server log: the model's share and the search
    // share are different problems with different fixes.
    const started = Date.now();
    let mark = started, modelMs = 0, toolMs = 0, rounds = 0;
    try {
      for await (const event of stream(model, tool, {
        instruction: INSTRUCTION,
        ask,
        history: store.transcript(conversation.id),
        endings: answerShapes(() => tool.sources, () => tool.snapshots),
        // Prose quotes are checked against what each source actually said; a miss goes back once.
        checkReply: (text) => {
          // Proportionate: a citation standing in for the fact, a malformed one or an unknown source
          // always goes back; one or two quotes that miss are cheaper shown flagged than rewritten.
          const misses = quoteProblems(citationsIn(text), tool.snapshots);
          const structural = [...misses.filter((p) => p.reason === "unknown source"), ...malformedCitations(text), ...bareCitations(text)];
          const quoteMisses = misses.filter((p) => p.reason !== "unknown source");
          const problems = structural.length || quoteMisses.length > 2 ? [...structural, ...quoteMisses] : [];
          return problems.length ? describeProblems(problems) : null;
        },
        // The re-reads are done, so a re-check gets one round for gaps and then answers.
        ...(prefetched ? { maxRounds: 2 } : {}),
        signal: input.signal,
      })) {
        if (event.type === "retract") {
          spoke = "";
          out.push({ type: "retract" });
        } else if (event.type === "delta") {
          const d = event.delta;
          if (d.type === "text") {
            spoke += d.text;
            out.push({ type: "text", text: d.text });
          } else if (d.type === "tool_start") {
            // Whatever was said before a tool call is a note on the way, not the answer. For an
            // answer shape, the conclusion is its `headline`.
            spoke = "";
            out.push({ type: "searching" });
          } else if (d.type === "tool_input" && d.name.startsWith(ENDING_PREFIX)) {
            out.push({ type: "shape", shape: d.name.slice(ENDING_PREFIX.length), partial: d.partial });
          }
        } else if (event.type === "entry") {
          fresh.push(event.entry);
          const now = Date.now();
          if (event.entry.kind === "said") (modelMs += now - mark), rounds++;
          if (event.entry.kind === "ran") toolMs += now - mark;
          mark = now;
        } else {
          const turn = record(event.shape, event.text, markCardQuotes(event.answer, tool.snapshots));
          store.append(conversation.id, [ask, ...fresh]);
          store.saveTurn(turn);
          store.saveSnapshots(turn, tool.snapshots);
          store.touch(conversation.id, clock.now());
          out.push({ type: "done", turn, cutShort: event.cutShort });
          const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
          log(
            `turn ${turn.id.slice(0, 8)} ${model.info.label}${memory.recheck ? " (re-check)" : ""}: ${rounds} model rounds ${s(modelMs)}, ` +
              `${tool.sources.length} sources from ${activity.filter((a) => a.kind === "search").length} searches ${s(toolMs)}, total ${s(Date.now() - started)}, ${turn.shape}`,
          );
          ledger.record(turn).then(
            (n) => n && log(`ledger: ${n} claim${n === 1 ? "" : "s"} recorded for turn ${turn.id}`),
            (error) => log(`ledger: ${(error as Error).message}`),
          );
          return;
        }
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
    }
  }
}

function titleFrom(message: string): string {
  const line = message.split("\n")[0].trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/**
 * Flags each quoted source entry in a card as verified or not, for the screen. And a verdict with
 * nothing behind it is unverified by definition: "unchanged" citing no source is shown as such.
 */
function markCardQuotes(answer: unknown, snapshots: ReadonlyMap<string, string>): unknown {
  for (const item of (answer as { items?: { status: string; sources: unknown[]; note?: string }[] } | undefined)?.items ?? []) {
    if (item.status === "unchanged" && !item.sources.length) {
      item.status = "unverified";
      item.note = item.note ? `${item.note} (no source re-read this)` : "No source re-read this.";
    }
  }
  for (const ref of collectRefs(answer)) {
    if (typeof ref === "string") continue;
    const snapshot = snapshots.get(ref.id);
    ref.verified = snapshot !== undefined && quoteFound(ref.quote, snapshot);
  }
  return answer;
}
