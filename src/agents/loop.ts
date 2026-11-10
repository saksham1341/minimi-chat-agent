/**
 * The agent loop: ask the model, run what it asks for, ask again.
 *
 * Ported from Keel's `keel/agents/loop.py` and written out rather than taken from an SDK's tool
 * runner, because four things a runner would decide are ours. All four fail quietly, so they are
 * stated here:
 *
 *   one message      every result of a parallel round goes back in a single `Ran`. Splitting them
 *                    teaches the model that parallel calls were not wanted, and it stops making
 *                    them, which reads as the agent getting slower
 *   failures return  a tool that threw comes back as a failed result, never as an omission. The
 *                    model asked and is owed an answer; a missing one desynchronises the turn
 *   a ceiling        after `maxRounds` requests the search tool is withdrawn and the model is told
 *                    to answer with what it has. A model that keeps searching without concluding
 *                    is not rare, and without a bound that failure is spend and a spinning UI
 *   endings          how a turn may finish. Plain text is always allowed (it is a reply). Each
 *                    structured shape (a comparison, a what-changed report, a set of choices) is
 *                    offered as a tool, because tool arguments are the one place every provider
 *                    already enforces a schema. Calling one, alone, ends the turn
 *
 * Nothing here knows a vendor. The model and the tools arrive as ports.
 */
import { Channel } from "./channel.ts";
import type { Asked, Entry, Ran, Said, ToolCall, ToolResult } from "./conversation.ts";
import { asked } from "./conversation.ts";
import type { ChatModel, ModelDelta, ToolSpec, ToolSurface } from "./ports.ts";

export const ENDING_PREFIX = "answer_";
export const DEFAULT_MAX_ROUNDS = 3;
/** Rounds allowed past the ceiling for fixing an invalid answer. After that the turn ends regardless. */
const GRACE_ROUNDS = 2;
/** Tool-call markup written as text: the model meant to call a tool and wrote the call instead. */
const LEAKED_CALL = /<\s*(?:invoke|function_calls|parameter)\b|<\/?\s*antml:/;
const MAX_LEAK_RETRIES = 2;

/** One way a turn is allowed to end, besides plain text. */
export interface OutputShape {
  /** e.g. `comparison`; offered to the model as `answer_comparison`. */
  name: string;
  description: string;
  schema: Record<string, unknown>;
  /** Checks arguments that arrived by streaming, which the provider no longer validates. */
  parse(input: unknown): { ok: true; value: unknown } | { ok: false; error: string };
}

export const toolName = (shape: OutputShape) => `${ENDING_PREFIX}${shape.name}`;

export type LoopEvent =
  | { type: "delta"; delta: ModelDelta }
  | { type: "entry"; entry: Entry }
  /** What was streamed this round was not an answer (a tool call written as text): take it back. */
  | { type: "retract" }
  | {
      type: "done";
      /** `reply` for plain text, otherwise the shape's name. */
      shape: string;
      text: string;
      answer?: unknown;
      rounds: number;
      /** True when the ceiling was reached and the model was made to answer early. */
      cutShort: boolean;
    };

export interface LoopInput {
  instruction: string;
  ask: Asked;
  history?: Entry[];
  endings?: OutputShape[];
  maxRounds?: number;
  /**
   * A check on a plain-text answer the caller can verify (quotes against their sources, say). A
   * problem goes back to the model once; a second failure ends the turn anyway and the caller
   * decides how to show what did not hold up.
   */
  checkReply?: (text: string) => string | null;
  signal?: AbortSignal;
}

/**
 * One turn, handed over as it happens. Yields token deltas for the screen and whole entries for
 * the record. The history passed in is not yielded back (the caller already has it), and neither
 * is the ask: what comes out is only what is new.
 */
export function stream(model: ChatModel, tools: ToolSurface, input: LoopInput): AsyncIterable<LoopEvent> {
  const out = new Channel<LoopEvent>();
  run(model, tools, input, out).then(
    () => out.close(),
    (error) => out.close(error),
  );
  return out;
}

async function run(model: ChatModel, tools: ToolSurface, input: LoopInput, out: Channel<LoopEvent>) {
  const endings = input.endings ?? [];
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const offeredTools = await tools.offered();
  const trespassing = offeredTools.filter((t) => t.name.startsWith(ENDING_PREFIX)).map((t) => t.name);
  if (trespassing.length) throw new Error(`${trespassing.join(", ")} would be read as an ending`);

  const ways = new Map(endings.map((shape) => [toolName(shape), shape]));
  const endingSpecs: ToolSpec[] = endings.map((shape) => ({
    name: toolName(shape),
    description: shape.description,
    inputSchema: shape.schema,
    streamsInput: true,
  }));
  const offered = [...offeredTools, ...endingSpecs];

  const conversation: Entry[] = [...(input.history ?? []), input.ask];
  const record = (entry: Entry) => {
    conversation.push(entry);
    out.push({ type: "entry", entry });
  };

  let rounds = 0;
  let cutShort = false;
  let leaks = 0;
  let replyFixes = 0;
  let lastWords = "";
  while (true) {
    if (rounds >= maxRounds + GRACE_ROUNDS) {
      // Every bounce (an invalid answer, a broken call) costs a round. Past the grace, stop and
      // hand over the best prose there is, rather than spend without bound.
      out.push({ type: "done", shape: "reply", text: lastWords || "I couldn't put a reliable answer together this time.", rounds, cutShort: true });
      return;
    }
    if (rounds >= maxRounds && !cutShort) {
      // Withdraw the tools rather than stopping dead: an answer from what was found, with the
      // gaps named, is worth more to the person than an error.
      cutShort = true;
      record(
        asked(
          "You have used this turn's search budget. Answer now from what you have already found. " +
            "Say plainly what you could not verify.",
          undefined,
          "runtime",
        ),
      );
    }

    const said: Said = await model.respond(
      { instruction: input.instruction, history: conversation, tools: cutShort ? endingSpecs : offered, signal: input.signal },
      (delta) => out.push({ type: "delta", delta }),
    );
    rounds += 1;

    const calls = said.toolCalls;
    if (calls.length === 0 && LEAKED_CALL.test(said.text)) {
      // Seen with Sonnet 4.5: the call written out as XML in the text instead of made. Showing it
      // would put markup in front of the person; accepting it would end the turn with no answer.
      record(said);
      out.push({ type: "retract" });
      if (leaks++ < MAX_LEAK_RETRIES) {
        record(asked("Your last message wrote a tool call out as text instead of calling the tool. Make the call itself.", undefined, "runtime"));
        continue;
      }
      const prose = said.text.slice(0, said.text.search(LEAKED_CALL)).trim();
      out.push({ type: "done", shape: "reply", text: prose || lastWords || "I couldn't put that answer together. Ask me again?", rounds, cutShort });
      return;
    }
    if (said.text.trim()) lastWords = said.text.trim();
    if (calls.length === 0) {
      const problem = input.checkReply?.(said.text);
      if (problem && replyFixes++ < 1) {
        record(said);
        out.push({ type: "retract" });
        record(asked(problem, undefined, "runtime"));
        continue;
      }
      record(said);
      out.push({ type: "done", shape: "reply", text: said.text, rounds, cutShort });
      return;
    }

    const ending = calls.length === 1 ? ways.get(calls[0].name) : undefined;
    if (ending) {
      const parsed = ending.parse(calls[0].arguments);
      record(said);
      if (parsed.ok) {
        // The arguments are the answer, so there is nothing to run. The call is still answered,
        // because a history with an unanswered call is one the provider will refuse next turn.
        record({ kind: "ran", results: [{ callId: calls[0].id, name: calls[0].name, content: "Shown to the user.", failed: false }] });
        out.push({ type: "done", shape: ending.name, text: said.text, answer: parsed.value, rounds, cutShort });
        return;
      }
      record({
        kind: "ran",
        results: [{ callId: calls[0].id, name: calls[0].name, content: `Invalid arguments: ${parsed.error}. Call it again with arguments that match the schema.`, failed: true }],
      });
      continue;
    }

    record(said);
    const ran: Ran = { kind: "ran", results: await carryOut(tools, calls, ways, input.signal) };
    record(ran);
  }
}

/**
 * Run a round's calls together and answer every one. An ending called beside other tools is
 * refused, not run: an ending is only an ending alone, and the work beside it is still owed.
 */
async function carryOut(
  tools: ToolSurface,
  calls: ToolCall[],
  ways: Map<string, OutputShape>,
  signal?: AbortSignal,
): Promise<ToolResult[]> {
  return Promise.all(
    calls.map(async (call): Promise<ToolResult> => {
      if (ways.has(call.name)) {
        return {
          callId: call.id,
          name: call.name,
          failed: true,
          content: "Refused: an answer shape ends the turn, so call it on its own after the searches are back.",
        };
      }
      try {
        return await tools.run(call, signal);
      } catch (error) {
        return { callId: call.id, name: call.name, failed: true, content: `Failed: ${(error as Error).message}` };
      }
    }),
  );
}
