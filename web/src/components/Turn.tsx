/** One question and its answer: the trail, the prose, the card, the sources. */
import type { Source } from "../api.ts";
import type { ViewTurn } from "../view.ts";
import { Artifact } from "./Artifacts.tsx";
import { citedIds, Prose } from "./Prose.tsx";
import { Trail } from "./Trail.tsx";

export function Turn({ turn, last, onPick, modelLabel }: { turn: ViewTurn; last: boolean; onPick: (reply: string) => void; modelLabel?: string }) {
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
        <Trail activity={turn.activity} notes={turn.notes} live={live} sourceCount={turn.sources.length} />
        {turn.text && <Prose text={turn.text} sources={turn.sources} />}
        {turn.shape !== "reply" && <Artifact shape={turn.shape} answer={turn.answer} sources={turn.sources} live={live} onPick={onPick} canPick={last} />}
        {live && !turn.text && turn.shape === "reply" && turn.activity.some((a) => a.kind === "search" && a.results !== undefined) && <p className="writing">Reading the results</p>}
        {turn.cutShort && <p className="aside">I stopped searching to answer with what I had.</p>}
        {turn.status === "error" && <p className="error">{turn.error ?? "Something went wrong."} Send the message again to retry.</p>}
        {!live && shown.length > 0 && (
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
        )}
        {!live && modelLabel && <p className="model-mark">{modelLabel}</p>}
      </div>
    </article>
  );
}
