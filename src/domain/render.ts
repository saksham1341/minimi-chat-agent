/** A structured answer as plain text: what full-text recall matches and the next turn quotes. */
import type { z } from "zod";
import type { Changes, Choices, Comparison } from "./answers.ts";

export function answerAsText(shape: string, text: string, answer?: unknown): string {
  const lead = text.trim();
  if (shape === "comparison") {
    const c = answer as z.infer<typeof Comparison>;
    const rows = c.rows.map((r) => `- ${r.name}: ${c.columns.map((col, i) => `${col} ${r.cells[i] ?? "n/a"}`).join("; ")}`);
    return [lead, c.title, ...rows, c.takeaway].filter(Boolean).join("\n");
  }
  if (shape === "changes") {
    const c = answer as z.infer<typeof Changes>;
    const items = c.items.map((i) => `- ${i.subject}: ${i.status}${i.before ? `, was ${i.before}` : ""}${i.now ? `, now ${i.now}` : ""}${i.note ? ` (${i.note})` : ""}`);
    return [lead, `${c.title} (since ${c.since})`, ...items, c.summary].filter(Boolean).join("\n");
  }
  if (shape === "choices") {
    const c = answer as z.infer<typeof Choices>;
    return [lead, c.question, ...c.options.map((o) => `- ${o.label}`)].filter(Boolean).join("\n");
  }
  return lead;
}
