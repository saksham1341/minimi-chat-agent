/**
 * Conversations filed under the day they started, on a spine. When the agent looks back at a
 * day, that day is marked: you can see which part of your history it is answering from.
 */
import type { Conversation } from "../api.ts";
import { dayName, localDay } from "../view.ts";

export function Sidebar(props: {
  conversations: Conversation[];
  currentId: string | null;
  today: string;
  recalled: string[];
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const days = new Map<string, Conversation[]>();
  for (const c of props.conversations) {
    const day = localDay(c.createdAt);
    days.set(day, [...(days.get(day) ?? []), c]);
  }
  // A recalled day with no conversation still gets a mark: "nothing here" is an answer too.
  for (const day of props.recalled) if (!days.has(day)) days.set(day, []);
  const ordered = [...days.entries()].sort(([a], [b]) => b.localeCompare(a));

  return (
    <nav className="sidebar" aria-label="Conversations">
      <button className="new-chat" onClick={props.onNew}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        New conversation
      </button>
      {ordered.length ? (
        <ol className="spine">
          {ordered.map(([day, conversations]) => {
            const recalled = props.recalled.includes(day);
            return (
              <li key={day} className={`spine-day${recalled ? " is-recalled" : ""}`}>
                <span className="spine-label">
                  {dayName(day, props.today)}
                  {recalled && <span className="spine-flag">looked back</span>}
                </span>
                {conversations.length ? (
                  <ul>
                    {conversations.map((c) => (
                      <li key={c.id}>
                        <button className={`spine-item${c.id === props.currentId ? " is-current" : ""}`} onClick={() => props.onOpen(c.id)} title={c.title}>
                          {c.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="spine-empty">No conversations</p>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="sidebar-empty">Your conversations will be kept here, by day.</p>
      )}
    </nav>
  );
}
