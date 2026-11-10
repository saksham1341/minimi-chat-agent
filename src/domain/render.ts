/** A structured answer as plain text, with each row's source ids: what memory shows and later turns replay. */
import type { z } from "zod";
import { refId, type Changes, type Choices, type Comparison, type SourceRef } from "./answers.ts";
import { withoutTopics } from "./annotations.ts";
import { withoutQuotes } from "./quotes.ts";

export function answerAsText(shape: string, text: string, answer?: unknown): string {
  return withoutTopics(withoutQuotes(render(shape, text, answer)));
}

function render(shape: string, text: string, answer?: unknown): string {
  const lead = text.trim();
  if (shape === "comparison") {
    const c = answer as z.infer<typeof Comparison>;
    const rows = c.rows.map((r) => `- ${r.name}: ${c.columns.map((col, i) => `${col} ${r.cells[i] ?? "n/a"}`).join("; ")}${tags(r.sources)}`);
    return [c.headline, c.title, ...rows, c.takeaway].filter(Boolean).join("\n");
  }
  if (shape === "changes") {
    const c = answer as z.infer<typeof Changes>;
    const items = c.items.map((i) => `- ${i.subject}: ${i.status}${i.before ? `, was ${i.before}` : ""}${i.now ? `, now ${i.now}` : ""}${i.note ? ` (${i.note})` : ""}${tags(i.sources)}`);
    return [c.headline, `${c.title} (since ${c.since})`, ...items, c.summary].filter(Boolean).join("\n");
  }
  if (shape === "choices") {
    const c = answer as z.infer<typeof Choices>;
    return [lead, c.question, ...c.options.map((o) => `- ${o.label}`)].filter(Boolean).join("\n");
  }
  return lead;
}

const tags = (refs: SourceRef[] = []) => (refs.length ? ` ${[...new Set(refs.map(refId))].map((id) => `[${id}]`).join("")}` : "");
