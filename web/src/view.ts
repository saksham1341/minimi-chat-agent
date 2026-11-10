/** How a turn looks on screen, whether it is streaming in or loaded from history. */
import type { Activity, Source, TurnEvent, TurnRecord } from "./api.ts";

export interface ViewTurn {
  id: string;
  question: string;
  at: string;
  status: "streaming" | "done" | "error";
  /** Text of the round in progress, or the final answer. */
  text: string;
  /** What the model said before it went to search: shown in the trail, not as the answer. */
  notes: string[];
  activity: Activity[];
  sources: Source[];
  shape: string;
  answer?: unknown;
  model?: string;
  cutShort?: boolean;
  error?: string;
}

export const fromRecord = (t: TurnRecord): ViewTurn => ({
  id: t.id,
  question: t.question,
  at: t.at,
  status: "done",
  text: t.lead,
  notes: [],
  activity: t.activity,
  sources: t.sources,
  shape: t.shape,
  answer: t.answer,
  model: t.model,
});

export function pending(id: string, question: string): ViewTurn {
  return { id, question, at: new Date().toISOString(), status: "streaming", text: "", notes: [], activity: [], sources: [], shape: "reply" };
}

/** Folds one server event into the turn it belongs to. */
export function apply(turn: ViewTurn, event: TurnEvent): ViewTurn {
  switch (event.type) {
    case "start":
      return { ...turn, id: event.turnId, at: event.at, model: event.model.id };
    case "activity":
      return { ...turn, activity: event.activity };
    case "sources":
      return { ...turn, sources: event.sources };
    case "text":
      return { ...turn, text: turn.text + event.text };
    case "searching":
      return turn.text.trim() ? { ...turn, notes: [...turn.notes, turn.text.trim()], text: "" } : turn;
    case "shape": {
      const headline = (event.partial as { headline?: string } | null)?.headline;
      return { ...turn, shape: event.shape, answer: event.partial, ...(headline ? { text: headline } : {}) };
    }
    case "done": {
      const t = event.turn;
      return { ...turn, status: "done", text: t.lead, shape: t.shape, answer: t.answer, sources: t.sources, activity: t.activity, cutShort: event.cutShort };
    }
    case "error":
      return { ...turn, status: "error", error: event.message };
  }
}

/** The local calendar day of an instant, YYYY-MM-DD. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayName(day: string, today: string): string {
  if (day === today) return "Today";
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const [ty, tm, td] = today.split("-").map(Number);
  const diff = Math.round((new Date(ty, tm - 1, td).getTime() - date.getTime()) / 86_400_000);
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(y !== ty ? { year: "numeric" } : {}) });
}
