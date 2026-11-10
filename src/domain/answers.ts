/**
 * The shapes an answer can take besides plain text.
 *
 * Each is offered to the model as a tool whose arguments are the answer. One zod schema per
 * shape is both what the model is shown (as JSON Schema) and what checks what comes back, since
 * streamed tool input is not validated by the provider. The UI draws each one as its own card.
 *
 * Three shapes, because the questions this agent is for come in three kinds that prose serves
 * badly: several options side by side; what is different now from what was said before; and a
 * question back to the person when guessing would waste their time.
 */
import { z } from "zod";
import type { OutputShape } from "../agents/loop.ts";
import type { Source } from "./memory.ts";

const sourceIds = z
  .array(z.string())
  .describe('Ids of the search results that back this, e.g. ["S2", "S5"]. Empty only if it comes from memory.');

export const Comparison = z.object({
  headline: z
    .string()
    .describe("The conclusion in one sentence, as you would say it to the person. Shown above the card. Never narrate what you did."),
  title: z.string().describe("What is being compared, e.g. 'CRM tools for a 20-person sales team'."),
  columns: z.array(z.string()).min(1).max(5).describe("The attributes compared, e.g. ['Price / seat / mo', 'Free tier', 'Notable']."),
  rows: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().optional().describe("The option's own site, if known."),
        cells: z.array(z.string()).describe("One terse value per column, in column order: a few words or a number, not a sentence. 'n/a' or 'not public' when unknown."),
        sources: sourceIds,
      }),
    )
    .min(2),
  takeaway: z.string().describe("Two or three sentences of markdown: which fits whom, and why. Cite as [S#]."),
});

export const Changes = z.object({
  headline: z
    .string()
    .describe("The conclusion in one sentence, as you would say it to the person. Shown above the card. Never narrate what you did."),
  title: z.string(),
  since: z.string().describe("The baseline: the date the earlier answer was given, YYYY-MM-DD."),
  items: z
    .array(
      z.object({
        subject: z.string().describe("The thing checked, e.g. 'Neon, Launch plan price'."),
        status: z
          .enum(["changed", "unchanged", "corrected", "new", "unverified"])
          .describe(
            "'changed' only with evidence that it differs now from what was said at the baseline: the vendor's own current page, " +
              "or a source published on or after `since`. A source published before `since` cannot show a change. Sources " +
              "disagreeing, or annual vs monthly billing, is not a change: say 'unchanged' with a note, or 'unverified'. " +
              "'corrected' when what you said then was already wrong or imprecise at the time (for example you gave the " +
              "monthly price as if it were the only one): own it, and put the accurate value in `now`.",
          ),
        before: z.string().optional().describe("What was said or true at the baseline."),
        now: z.string().optional().describe("What is true now."),
        note: z.string().optional().describe("One line: when it changed, or why it could not be verified."),
        sources: sourceIds,
      }),
    )
    .min(1),
  summary: z.string().describe("One or two sentences of markdown: the bottom line. Cite as [S#]."),
});

export const Choices = z.object({
  question: z.string().describe("The question, short."),
  options: z
    .array(z.object({ label: z.string(), reply: z.string().describe("What gets sent as the person's message if they pick it.") }))
    .min(2)
    .max(5),
});

type Check = (value: never) => string | null;

function shape(name: string, schema: z.ZodType, description: string, check?: Check): OutputShape {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return {
    name,
    description,
    schema: json,
    parse(input) {
      const result = schema.safeParse(input);
      if (!result.success) {
        return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
      }
      const problem = check?.(result.data as never);
      return problem ? { ok: false, error: problem } : { ok: true, value: result.data };
    },
  };
}

/**
 * The rule a "changed" verdict has to meet, checked here because it is checkable: the harness
 * holds every source's published date. A change since the baseline needs a cited source that is
 * either undated (a live page: pricing pages change in place) or dated on or after the baseline.
 * A page from before the baseline can only show what was already true then.
 */
export function evidenceProblem(changes: z.infer<typeof Changes>, sources: Source[]): string | null {
  const problems: string[] = [];
  for (const item of changes.items) {
    if (item.status !== "changed") continue;
    if (!item.sources.length) {
      problems.push(`"${item.subject}" is marked changed but cites no source`);
      continue;
    }
    const cited = item.sources.map((id) => sources.find((s) => s.id === id)).filter((s): s is Source => !!s);
    if (cited.length && cited.every((s) => s.published && s.published < changes.since)) {
      const dates = cited.map((s) => `${s.id} published ${s.published}`).join(", ");
      problems.push(`"${item.subject}" is marked changed, but every source it cites predates ${changes.since} (${dates})`);
    }
  }
  return problems.length
    ? `${problems.join("; ")}. A page from before the baseline cannot show a change since then. Check the vendor's current page, or mark it unchanged or unverified, then call answer_changes again.`
    : null;
}

/** The answer shapes for one turn. `sources` is that turn's numbered results, for the evidence rule. */
export function answerShapes(sources: () => Source[] = () => []): OutputShape[] {
  return [
    shape(
      "comparison",
      Comparison,
      "Answer with a comparison table, ending the turn. Use when the person is weighing three or more options on the " +
        "same attributes (tools, plans, providers). Do the searches first; every cell should be backed by a source.",
    ),
    shape(
      "changes",
      Changes,
      "Answer with a what-changed report against an earlier answer, ending the turn. Use when the person asks whether " +
        "something you told them before is still true, or what changed since a date. One item per product or option, " +
        "covering all its facts (not one item per attribute); leave `note` empty when nothing changed; " +
        "mark 'unverified' honestly when the search could not confirm it either way.",
      ((value: z.infer<typeof Changes>) => evidenceProblem(value, sources())) as Check,
    ),
    shape(
      "choices",
      Choices,
      "Ask the person one short question with tappable answers, ending the turn. Use only when you cannot give a useful " +
        "answer without it (for example they refer to an earlier conversation you have no record of and the details " +
        "matter). Never use it to ask permission to search.",
    ),
  ];
}

export const ANSWER_SHAPES = answerShapes();
