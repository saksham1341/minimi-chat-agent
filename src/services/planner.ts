/**
 * Search fan-out: before the answering model starts, a light model plans every search the message
 * needs, in one go, and they run in parallel. The answering model then starts with the results in
 * hand instead of spending its first round deciding what to search, which is a whole model round
 * and a search the person waited for, every time.
 *
 * It plans; it does not answer. An empty plan (small talk, a question about the conversation, an
 * answer memory already has) costs a second and skips searching. The answering model can still
 * search for anything the plan missed.
 */
import { asked } from "../agents/conversation.ts";
import { PLAN_SHAPE } from "../domain/answers.ts";
import { Plan } from "../domain/plan.ts";
import type { AgentRuntimePort } from "../ports/runtime.ts";
import type { SearchInput } from "./web-search.ts";

export const PLAN_INSTRUCTION = `You plan the web searches an assistant needs before it answers a message. You do not answer. Call answer_searches once.

- Plan every search the answer needs, at once: they run in parallel. One per option being compared, one per fact that could have changed, usually 1 to 5.
- For a current price, plan, limit or version, search the vendor's own page: \`domains\` set to its site and \`fresh: true\`. For news or changes since a date, use \`since\`.
- Plan nothing for small talk, for questions about the conversation itself, or for stable knowledge that cannot have changed.
- Write queries the way you would type them into a search engine.`;

export class Planner {
  constructor(private readonly deps: { runtime: AgentRuntimePort; log: (message: string) => void }) {}

  /** The searches to run before the answer, or none. Never throws: a failed plan is an empty one. */
  async plan(o: { model: string; message: string; context: string }): Promise<SearchInput[]> {
    const started = Date.now();
    try {
      const events = this.deps.runtime.run({
        runId: crypto.randomUUID(),
        model: o.model,
        instruction: PLAN_INSTRUCTION,
        history: [],
        ask: asked(`<message>\n${o.message}\n</message>`, o.context),
        endings: [{ name: PLAN_SHAPE.name, description: PLAN_SHAPE.description, schema: PLAN_SHAPE.schema }],
        maxRounds: 1,
        tools: false,
      });
      for await (const event of events) {
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "done" && event.shape === PLAN_SHAPE.name) {
          const parsed = Plan.safeParse(event.answer);
          const searches = parsed.success ? parsed.data.searches.slice(0, 6) : [];
          this.deps.log(`plan: ${searches.length} searches, ${((Date.now() - started) / 1000).toFixed(1)}s`);
          return searches;
        }
      }
    } catch (error) {
      this.deps.log(`plan: failed (${(error as Error).message})`);
    }
    return [];
  }
}
