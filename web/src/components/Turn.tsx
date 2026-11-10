/** One question and its answer: the trail, the prose, the card, the sources. */
import { useState } from "react";
import type { Source } from "../api.ts";
import type { ViewTurn } from "../view.ts";
import { Artifact } from "./Artifacts.tsx";
import { citedIds, Prose } from "./Prose.tsx";
import { Trail } from "./Trail.tsx";

const SHAPE_NAME: Record<string, string> = { comparison: "Comparison", changes: "What changed", choices: "Question" };

export function Turn(props: {
  turn: ViewTurn;
  last: boolean;
  onPick: (reply: string) => void;
  modelLabel?: string;
  /** The canvas is on screen: work and cards are drawn there, so the thread only points at them. */
  canvas: boolean;
  focused: boolean;
  onFocus: () => void;
}) {
  const { turn, last, onPick, modelLabel, canvas, focused, onFocus } = props;
  const live = turn.status === "streaming";
  const cited = citedIds(turn.text, JSON.stringify(turn.answer ?? ""));
  const shown: Source[] = cited.map((id) => turn.sources.find((s) => s.id === id)).filter((s): s is Source => !!s);
  const time = new Date(turn.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  return (
    <article className="turn" aria-busy={live}>
      <div className="question">
        <p>{turn.question}</p>
        <time dateTime={turn.at}>{time}</time>
      </div>
      <div className="answer">
        {canvas && live ? (
          <button className="working" onClick={onFocus}>
            <span className="working-dot" aria-hidden />
            Working on it in the canvas
          </button>
        ) : (
          <Trail activity={turn.activity} notes={turn.notes} live={live} sourceCount={turn.sources.length} />
        )}
        {turn.text && <Prose text={turn.text} sources={turn.sources} />}
        {turn.shape !== "reply" && turn.answer !== undefined && canvas && turn.shape !== "choices" ? (
          <button className={`canvas-ref${focused ? " is-focused" : ""}`} onClick={onFocus}>
            <span className="canvas-ref-kind">{SHAPE_NAME[turn.shape] ?? "Answer"}</span>
            <span className="canvas-ref-title">{(turn.answer as { title?: string }).title ?? ""}</span>
            <span className="canvas-ref-action">{focused ? "In the canvas" : "Open in canvas"}</span>
          </button>
        ) : (
          turn.shape !== "reply" && <Artifact shape={turn.shape} answer={turn.answer} sources={turn.sources} live={live} onPick={onPick} canPick={last} />
        )}
        {live && !canvas && !turn.text && turn.shape === "reply" && turn.activity.some((a) => a.kind === "search" && a.results !== undefined) && <p className="writing">Reading the results</p>}
        {turn.cutShort && <p className="aside">I stopped searching to answer with what I had.</p>}
        {turn.status === "error" && <p className="error">{turn.error ?? "Something went wrong."} Send the message again to retry.</p>}
        {!live && shown.length > 0 && <Sources sources={shown} />}
        {!live && modelLabel && <p className="model-mark">{modelLabel}</p>}
      </div>
    </article>
  );
}

/** The sources an answer cited, the first few shown: a long list is reference, not reading. */
function Sources({ sources }: { sources: Source[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? sources : sources.slice(0, 6);
  return (
    <div className="sources-block">
      <ol className="sources" aria-label="Sources">
        {shown.map((s) => (
          <li key={s.id}>
            <a href={s.url} target="_blank" rel="noreferrer noopener">
              <span className="source-id">{s.id.slice(1)}</span>
              <span className="source-domain">{s.domain}</span>
              <span className="source-title">{s.title}</span>
            </a>
          </li>
        ))}
      </ol>
      {sources.length > 6 && (
        <button className="sources-more" onClick={() => setAll(!all)}>
          {all ? "Show fewer sources" : `Show all ${sources.length} sources`}
        </button>
      )}
    </div>
  );
}
