/**
 * The canvas: the agent's work, drawn as it happens. What it remembered, each search as a lane
 * with its sources landing in it, then the answer filling in cell by cell. The chat keeps the
 * conversation; the canvas keeps the work.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Activity, Source } from "../api.ts";
import type { ViewTurn } from "../view.ts";
import { Artifact } from "./Artifacts.tsx";
import { Cite, citedIds, formatDay } from "./Prose.tsx";
import { Chevron } from "./icons.tsx";

type Search = Extract<Activity, { kind: "search" }>;
type Memory = Extract<Activity, { kind: "memory" }>;
type Step = "remember" | "search" | "read" | "write";
type State = "done" | "active" | "waiting" | "skipped";

export function phases(turn: ViewTurn): Record<Step, State> {
  const live = turn.status === "streaming";
  const recalled = turn.activity.some((a) => a.kind === "recall");
  // The steps follow the model's own searches; a read-ahead nobody has claimed yet is not one.
  const searches = turn.activity.filter((a): a is Search => a.kind === "search" && (!a.ahead || !!a.reused));
  const searching = searches.some((s) => s.results === undefined && !s.failed);
  const writing = !!turn.text || turn.answer !== undefined;
  const settled = (cond: boolean, active: boolean): State => (active ? "active" : cond ? "done" : live ? "waiting" : "skipped");
  return {
    // Recall happens before the model starts, so it is either done or did not apply.
    remember: recalled ? "done" : "skipped",
    search: settled(searches.length > 0, searching),
    read: settled(searches.length > 0 && !searching && writing, live && searches.length > 0 && !searching && !writing),
    write: settled(writing && !live, live && writing),
  };
}

const STEP_LABEL: Record<Step, string> = { remember: "Remember", search: "Search", read: "Read", write: "Write" };

export function Canvas({ turn, onPick, canPick, onClose, sheet }: { turn: ViewTurn; onPick: (reply: string) => void; canPick: boolean; onClose?: () => void; sheet?: boolean }) {
  const live = turn.status === "streaming";
  const steps = phases(turn);
  const memory = turn.activity.find((a): a is Memory => a.kind === "memory");
  const recalls = turn.activity.filter((a) => a.kind === "recall");
  const searches = turn.activity.filter((a): a is Search => a.kind === "search");
  const hasArtifact = turn.shape !== "reply" && turn.shape !== "choices" && turn.answer !== undefined;
  const cited = citedIds(turn.text, JSON.stringify(turn.answer ?? ""))
    .map((id) => turn.sources.find((s) => s.id === id))
    .filter((s): s is Source => !!s);

  // When the answer starts drawing, bring it into view: it is what the person is waiting for.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hasArtifact) body.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [hasArtifact, turn.id]);

  return (
    <aside className={`canvas${live ? " is-live" : ""}${sheet ? " is-sheet" : ""}`} aria-label="Work for this answer" {...(sheet ? { role: "dialog", "aria-modal": true } : {})}>
      <header className="canvas-head">
        <p className="canvas-question">{turn.question}</p>
        {onClose && (
          <button className="canvas-close" onClick={onClose} aria-label="Close canvas">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
          </button>
        )}
        <ol className="steps" aria-label="Progress">
          {(Object.keys(STEP_LABEL) as Step[]).map((step) => (
            <li key={step} className={`step is-${steps[step]}`} aria-current={steps[step] === "active" ? "step" : undefined}>
              <span className="step-dot" aria-hidden />
              {STEP_LABEL[step]}
            </li>
          ))}
        </ol>
      </header>

      <div className="canvas-body" ref={body}>
        {hasArtifact && (
          <section className="canvas-artifact">
            <Artifact shape={turn.shape} answer={turn.answer} sources={turn.sources} live={live} onPick={onPick} canPick={canPick} />
          </section>
        )}
        {!hasArtifact && steps.read === "active" && <p className="canvas-wait">Reading {turn.sources.length} sources</p>}

        {(recalls.length > 0 || memory) && (
          <Fold title="From memory" count={memory?.exchanges.length} open={!hasArtifact} className="memory">
            {recalls.map((r, i) => r.kind === "recall" && <p key={i} className="memory-line">{r.label}</p>)}
            {memory?.exchanges.map((e, i) => (
              <p key={i} className="memory-exchange">
                <time dateTime={e.at}>{formatDay(e.at.slice(0, 10))}</time>
                <span>{e.question}</span>
              </p>
            ))}
            {memory && memory.claims.length > 0 && <Claims claims={memory.claims} checking={live && steps.search !== "skipped"} />}
          </Fold>
        )}

        {searches.length > 0 && (
          <Fold title="Searches" count={searches.length} open={!hasArtifact}>
            <ul className="lanes">
              {searches.map((s) => (
                <SearchLane key={s.id} search={s} sources={turn.sources} />
              ))}
            </ul>
            {turn.notes.map((n, i) => (
              <p key={i} className="canvas-note">{n}</p>
            ))}
          </Fold>
        )}

        {!live && cited.length > 0 && (
          <Fold title="Sources cited" count={cited.length} open={!hasArtifact}>
            <ol className="sources">
              {cited.map((s) => (
                <li key={s.id}>
                  <a href={s.url} target="_blank" rel="noreferrer noopener">
                    <span className="source-id">{s.id.slice(1)}</span>
                    <span className="source-domain">{s.domain}</span>
                    <span className="source-title">{s.title}</span>
                    {s.published && <span className="source-date">{formatDay(s.published)}</span>}
                  </a>
                </li>
              ))}
            </ol>
          </Fold>
        )}
      </div>
    </aside>
  );
}

function SearchLane({ search, sources }: { search: Search; sources: Source[] }) {
  const busy = search.results === undefined && !search.failed;
  const filters = [search.since && `since ${formatDay(search.since)}`, ...(search.domains ?? []), search.fresh && "live read"].filter(Boolean) as string[];
  const tag = search.drafting ? "writing" : search.reused ? "ready" : search.ahead ? "read ahead" : "";
  return (
    <li className={`lane${busy ? " is-busy" : ""}${search.failed ? " is-failed" : ""}${search.ahead ? " is-ahead" : ""}${search.reused ? " is-reused" : ""}`}>
      <div className="lane-head">
        {tag && <span className="lane-tag">{tag}</span>}
        <span className="lane-query">{search.query}</span>
        {filters.map((f) => (
          <span key={f} className="lane-filter">{f}</span>
        ))}
      </div>
      <div className="lane-hits">
        {busy && <span className="lane-searching" aria-label="Searching" />}
        {search.failed && <span className="lane-error">{search.failed}</span>}
        {search.results === 0 && <span className="lane-none">No results</span>}
        {search.hits?.map((id) => {
          const s = sources.find((x) => x.id === id);
          return s ? (
            <span key={id} className="hit">
              <Cite id={id} sources={sources} />
              <span className="hit-domain">{s.domain}</span>
            </span>
          ) : null;
        })}
      </div>
    </li>
  );
}

/** A section that is open while the work is happening and folds away once the answer is up. */
function Fold({ title, count, open, className, children }: { title: string; count?: number; open: boolean; className?: string; children: ReactNode }) {
  const [shown, setShown] = useState(open);
  useEffect(() => setShown(open), [open]);
  return (
    <section className={`fold${className ? ` ${className}` : ""}`}>
      <button className="canvas-h fold-toggle" onClick={() => setShown(!shown)} aria-expanded={shown}>
        <Chevron open={shown} />
        {title}
        {count !== undefined && <span className="canvas-count">{count}</span>}
      </button>
      {shown && <div className="fold-body">{children}</div>}
    </section>
  );
}

function Claims({ claims, checking }: { claims: Memory["claims"]; checking: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? claims : claims.slice(0, 6);
  return (
    <ul className="claims">
      {shown.map((c, i) => (
        <li key={i} className={checking ? "is-checking" : ""}>
          <span className="claim-subject">{c.subject}</span>
          <span className="claim-value">{c.value}</span>
        </li>
      ))}
      {claims.length > 6 && (
        <li>
          <button className="claims-more" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${claims.length} facts`}</button>
        </li>
      )}
    </ul>
  );
}
