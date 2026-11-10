/** How a turn looks on screen, whether it is streaming in or loaded from history. */
import type { Activity, Source, TurnEvent, TurnRecord } from "./api.ts";

export interface ViewTurn {
  id: string;
  question: string;
  at: string;
  status: "streaming" | "done" | "error";
  /** Text of the round in progress, or the final answer. */
  text: string;
  /** What the model said before it went to search: working notes, shown while it works, not as the answer. */
  notes: string[];
  /** The model's reasoning so far, when the provider streams it. */
  thinking: string;
  /** Text being redone, kept on screen (dimmed) until the new text starts, so nothing vanishes. */
  draft?: string;
  revising?: string;
  /** Sources whose citations a correction just changed in place, to show where. */
  fixed?: string[];
  /** The answer's text is final: the working notes fold away. */
  settled: boolean;
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
  thinking: "",
  settled: true,
  activity: t.activity,
  sources: t.sources,
  shape: t.shape,
  answer: t.answer,
  model: t.model,
});

export function pending(id: string, question: string): ViewTurn {
  return { id, question, at: new Date().toISOString(), status: "streaming", text: "", notes: [], thinking: "", settled: false, activity: [], sources: [], shape: "reply" };
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
      return turn.draft !== undefined
        ? { ...turn, draft: undefined, revising: undefined, text: event.text }
        : { ...turn, text: turn.text + event.text };
    case "thinking":
      return { ...turn, thinking: (turn.thinking + event.text).slice(-4000) };
    case "revise":
      return { ...turn, draft: turn.text || turn.draft || "", revising: event.reason, text: "", settled: false };
    case "fixing":
      return { ...turn, revising: event.reason, settled: false };
    case "patch":
      return { ...turn, text: event.text, fixed: event.fixed, revising: undefined, settled: true };
    case "settled":
      return { ...turn, text: event.text, draft: undefined, revising: undefined, settled: true };
    case "searching":
      return turn.text.trim() ? { ...turn, notes: [...turn.notes, turn.text.trim()], text: "" } : turn;
    case "shape": {
      const headline = (event.partial as { headline?: string } | null)?.headline;
      return { ...turn, shape: event.shape, answer: event.partial, ...(headline ? { text: headline } : {}) };
    }
    case "done": {
      const t = event.turn;
      return { ...turn, status: "done", settled: true, draft: undefined, revising: undefined, text: t.lead, shape: t.shape, answer: t.answer, sources: t.sources, activity: t.activity, cutShort: event.cutShort };
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
