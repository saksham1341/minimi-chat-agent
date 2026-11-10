/**
 * One question and its answer. The answer shows the answer: the prose with its citations and the
 * card. How it got there (what was recalled, every search, every source) is the canvas's job, so
 * the thread carries one line that opens it: a live status while working, a quiet footer after.
 */
import type { ViewTurn } from "../view.ts";
import { Artifact } from "./Artifacts.tsx";
import { phases } from "./Canvas.tsx";
import { Prose } from "./Prose.tsx";

const SHAPE_NAME: Record<string, string> = { comparison: "Comparison", changes: "What changed", choices: "Question" };

export function Turn(props: {
  turn: ViewTurn;
  last: boolean;
  onPick: (reply: string) => void;
  modelLabel?: string;
  /** The canvas is beside the thread: cards are drawn there, so the thread only points at them. */
  canvas: boolean;
  focused: boolean;
  onFocus: () => void;
}) {
  const { turn, last, onPick, modelLabel, canvas, focused, onFocus } = props;
  const live = turn.status === "streaming";
  const time = new Date(turn.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const searches = turn.activity.filter((a) => a.kind === "search" && (!a.ahead || a.reused)).length;
  const recalled = turn.activity.some((a) => a.kind === "recall");
  const hasWork = searches > 0 || recalled || turn.shape === "comparison" || turn.shape === "changes";
  const card = turn.shape !== "reply" && turn.answer !== undefined;

  return (
    <article className="turn" aria-busy={live}>
      <div className="question">
        <p>{turn.question}</p>
        <time dateTime={turn.at}>{time}</time>
      </div>
      <div className="answer">
        {live && !turn.settled && <Status turn={turn} onOpen={onFocus} />}
        <Working turn={turn} />
        {live && !turn.text && turn.draft === undefined && turn.answer === undefined && <Skeleton />}
        {turn.draft !== undefined && <Prose className="prose is-draft" text={turn.draft} sources={turn.sources} />}
        {turn.text && <Prose className="prose is-arriving" text={turn.text} sources={turn.sources} />}
        {card &&
          (canvas && turn.shape !== "choices" ? (
            <button className={`canvas-ref${focused ? " is-focused" : ""}`} onClick={onFocus}>
              <span className="canvas-ref-kind">{SHAPE_NAME[turn.shape] ?? "Answer"}</span>
              <span className="canvas-ref-title">{(turn.answer as { title?: string }).title ?? ""}</span>
              <span className="canvas-ref-action">{focused ? "In the canvas" : "Open"}</span>
            </button>
          ) : (
            <Artifact shape={turn.shape} answer={turn.answer} sources={turn.sources} live={live} onPick={onPick} canPick={last} />
          ))}
        {turn.cutShort && <p className="aside">I stopped searching to answer with what I had.</p>}
        {turn.status === "error" && <p className="error">{turn.error ?? "Something went wrong."} Send the message again to retry.</p>}
        {!live && (
          <footer className="turn-foot">
            {hasWork ? (
              <button className={`turn-work${focused ? " is-focused" : ""}`} onClick={onFocus}>
                {[recalled && "remembered", searches && `${searches} search${searches === 1 ? "" : "es"}`, turn.sources.length && `${turn.sources.length} sources`]
                  .filter(Boolean)
                  .join(" · ")}
              </button>
            ) : null}
            {modelLabel && <span className="turn-model">{modelLabel}</span>}
          </footer>
        )}
      </div>
    </article>
  );
}

const STEP_TEXT = { remember: "Remembering", search: "Searching", read: "Reading", write: "Writing" } as const;

/** While the answer is being worked on: what is happening now, in one line that opens the work. */
function Status({ turn, onOpen }: { turn: ViewTurn; onOpen: () => void }) {
  const steps = phases(turn);
  const step = (["write", "read", "search", "remember"] as const).find((s) => steps[s] === "active");
  const lanes = turn.activity.filter((a) => a.kind === "search");
  const own = lanes.filter((a) => a.kind === "search" && !a.ahead && a.results === undefined && !a.failed).length;
  const ahead = lanes.filter((a) => a.kind === "search" && a.ahead && a.results === undefined && !a.failed).length;
  const label =
    step === "search" && own
      ? `Searching${own > 1 ? ` ${own} at once` : ""}`
      : (step === "read" || step === "search") && turn.sources.length
        ? `Reading ${turn.sources.length} sources`
        : step === "write"
          ? "Writing"
          : ahead
            ? "Reading ahead"
            : "Thinking";
  if (step === "write" && turn.text && !turn.revising) return null; // the answer itself is now the progress
  return (
    <button className="status" onClick={onOpen}>
      <span className="status-dot" aria-hidden />
      <span className="status-label">{turn.revising ?? label}</span>
    </button>
  );
}

/**
 * The model's working, in its own words, while it works: what it said before each search and its
 * reasoning when the provider streams it. Written to be read (the instruction says so), and folded
 * away once the answer is final; the canvas keeps the notes.
 */
function Working({ turn }: { turn: ViewTurn }) {
  const thinking = turn.thinking.trim();
  if (!turn.notes.length && !thinking) return null;
  const folded = turn.settled || turn.status !== "streaming";
  return (
    <div className={`working${folded ? " is-folded" : ""}`} aria-hidden={folded}>
      <div className="working-inner">
        {turn.notes.map((n, i) => (
          <p key={i} className="working-note">{n}</p>
        ))}
        {thinking && <p className="working-thinking">{thinking.length > 400 ? `…${thinking.slice(-400)}` : thinking}</p>}
      </div>
    </div>
  );
}

/** The shape of an answer, before there is one: something on screen from the first frame. */
function Skeleton() {
  return (
    <div className="skeleton" aria-hidden>
      <span style={{ width: "92%" }} />
      <span style={{ width: "86%" }} />
      <span style={{ width: "58%" }} />
    </div>
  );
}
