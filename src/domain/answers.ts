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

const sourceIds = z
  .array(z.string())
  .describe('Ids of the search results that back this, e.g. ["S2", "S5"]. Empty only if it comes from memory.');

export const Comparison = z.object({
  title: z.string().describe("What is being compared, e.g. 'CRM tools for a 20-person sales team'."),
  columns: z.array(z.string()).min(1).max(6).describe("The attributes compared, e.g. ['Price / seat / mo', 'Free tier', 'Notable']."),
  rows: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().optional().describe("The option's own site, if known."),
        cells: z.array(z.string()).describe("One short value per column, in column order. 'n/a' or 'not public' when unknown."),
        sources: sourceIds,
      }),
    )
    .min(2),
  takeaway: z.string().describe("Two or three sentences of markdown: which fits whom, and why. Cite as [S#]."),
});

export const Changes = z.object({
  title: z.string(),
  since: z.string().describe("The baseline: the date the earlier answer was given, YYYY-MM-DD."),
  items: z
    .array(
      z.object({
        subject: z.string().describe("The thing checked, e.g. 'Neon, Launch plan price'."),
        status: z.enum(["changed", "unchanged", "new", "unverified"]),
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

function shape(name: string, schema: z.ZodType, description: string): OutputShape {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return {
    name,
    description,
    schema: json,
    parse(input) {
      const result = schema.safeParse(input);
      return result.success
        ? { ok: true, value: result.data }
        : { ok: false, error: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
    },
  };
}

export const ANSWER_SHAPES: OutputShape[] = [
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
      "something you told them before is still true, or what changed since a date. One item per thing you checked; " +
      "mark 'unverified' honestly when the search could not confirm it either way.",
  ),
  shape(
    "choices",
    Choices,
    "Ask the person one short question with tappable answers, ending the turn. Use only when you cannot give a useful " +
      "answer without it (for example they refer to an earlier conversation you have no record of and the details " +
      "matter). Never use it to ask permission to search.",
  ),
];
