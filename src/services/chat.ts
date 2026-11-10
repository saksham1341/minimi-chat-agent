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
import { ANSWER_SHAPES } from "../domain/answers.ts";
import type { Activity, Conversation, Source, TurnRecord } from "../domain/memory.ts";
import { answerAsText } from "../domain/render.ts";
import type { Clock } from "../ports/clock.ts";
import type { MemoryStore } from "../ports/memory.ts";
import type { SearchProvider } from "../ports/search.ts";
import type { ModelCatalog } from "./catalog.ts";
import { INSTRUCTION } from "./instruction.ts";
import type { LedgerService } from "./ledger.ts";
import type { RecallService } from "./recall.ts";
import { SearchCache, WebSearchTool } from "./web-search.ts";

export type TurnEvent =
  | { type: "start"; conversation: Conversation; turnId: string; at: string; model: ModelInfo }
  | { type: "activity"; activity: Activity[] }
  | { type: "sources"; sources: Source[] }
  | { type: "text"; text: string }
  /** The model stopped talking to search; what it said so far was a note, not the answer. */
  | { type: "searching" }
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
  private readonly cache = new SearchCache();

  constructor(
    private readonly deps: {
      store: MemoryStore;
      clock: Clock;
      models: ModelCatalog;
      search: SearchProvider;
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
    const { store, clock, models, search, recall, ledger, log } = this.deps;
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

    const tool = new WebSearchTool(search, this.cache, (event, sources) => {
      const at = activity.findIndex((a) => a.kind === "search" && event.kind === "search" && a.id === event.id);
      if (at >= 0) activity[at] = event;
      else activity.push(event);
      out.push({ type: "activity", activity: [...activity] });
      out.push({ type: "sources", sources: [...sources] });
    });

    const ask = asked(message, memory.context);
    const fresh: Entry[] = [];
    const record = (shape: string, text: string, answer?: unknown): TurnRecord => ({
      id: turnId,
      conversationId: conversation.id,
      at: now.toISOString(),
      question: message,
      answerText: answerAsText(shape, text, answer),
      lead: text.trim(),
      shape,
      ...(answer === undefined ? {} : { answer }),
      sources: tool.sources,
      activity,
      model: model.info.id,
    });

    let spoke = "";
    try {
      for await (const event of stream(model, tool, {
        instruction: INSTRUCTION,
        ask,
        history: store.transcript(conversation.id),
        endings: ANSWER_SHAPES,
        signal: input.signal,
      })) {
        if (event.type === "delta") {
          const d = event.delta;
          if (d.type === "text") {
            spoke += d.text;
            out.push({ type: "text", text: d.text });
          } else if (d.type === "tool_start" && !d.name.startsWith(ENDING_PREFIX)) {
            spoke = "";
            out.push({ type: "searching" });
          } else if (d.type === "tool_input" && d.name.startsWith(ENDING_PREFIX)) {
            out.push({ type: "shape", shape: d.name.slice(ENDING_PREFIX.length), partial: d.partial });
          }
        } else if (event.type === "entry") {
          fresh.push(event.entry);
        } else {
          const turn = record(event.shape, event.text, event.answer);
          store.append(conversation.id, [ask, ...fresh]);
          store.saveTurn(turn);
          store.touch(conversation.id, clock.now());
          out.push({ type: "done", turn, cutShort: event.cutShort });
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
