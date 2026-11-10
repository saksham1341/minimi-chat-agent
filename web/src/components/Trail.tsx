/**
 * What the agent did to get its answer: the days it looked back at, the searches it ran. Live
 * while it works; folded into one line once the answer is there.
 */
import { useState } from "react";
import type { Activity } from "../api.ts";
import { formatDay } from "./Prose.tsx";

export function Trail({ activity, notes, live, sourceCount }: { activity: Activity[]; notes: string[]; live: boolean; sourceCount: number }) {
  const [open, setOpen] = useState(false);
  if (!activity.length && !notes.length) return live ? <div className="trail"><Line icon="dot" text="Thinking" busy /></div> : null;

  const recalls = activity.filter((a) => a.kind === "recall");
  const searches = activity.filter((a) => a.kind === "search");
  const summary = [
    recalls.length ? `Looked back ${recalls.length === 1 ? "once" : `${recalls.length} times`}` : "",
    searches.length ? `${searches.length} search${searches.length === 1 ? "" : "es"}` : "",
    sourceCount ? `${sourceCount} source${sourceCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean);

  const expanded = live || open;
  return (
    <div className={`trail${live ? " is-live" : ""}`}>
      {!live && (
        <button className="trail-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Chevron open={open} />
          {summary.join(", ")}
        </button>
      )}
      {expanded && (
        <ol className="trail-lines">
          {activity.map((a, i) =>
            a.kind === "recall" ? (
              <Line key={i} icon="memory" text={a.label} detail={a.detail} />
            ) : (
              <Line
                key={a.id}
                icon="search"
                text={a.query}
                detail={[
                  a.since ? `since ${formatDay(a.since)}` : "",
                  a.domains?.length ? a.domains.join(", ") : "",
                  a.failed ? `failed: ${a.failed}` : a.results !== undefined ? `${a.results} result${a.results === 1 ? "" : "s"}` : "",
                ]
                  .filter(Boolean)
                  .join(", ")}
                busy={a.results === undefined && !a.failed}
                failed={!!a.failed}
              />
            ),
          )}
          {notes.map((n, i) => (
            <li key={`n${i}`} className="trail-note">{n}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Line({ icon, text, detail, busy, failed }: { icon: "memory" | "search" | "dot"; text: string; detail?: string; busy?: boolean; failed?: boolean }) {
  return (
    <li className={`trail-line${failed ? " is-failed" : ""}`}>
      <span className={`trail-icon icon-${icon}${busy ? " is-busy" : ""}`} aria-hidden>
        {icon === "search" ? <SearchIcon /> : icon === "memory" ? <ClockIcon /> : null}
      </span>
      <span className="trail-text">{text}</span>
      {detail && <span className="trail-detail">{detail}</span>}
    </li>
  );
}

const SearchIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
);
const ClockIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
);
export const Chevron = ({ open }: { open: boolean }) => (
  <svg className={`chevron${open ? " is-open" : ""}`} viewBox="0 0 16 16" width="10" height="10" aria-hidden><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
