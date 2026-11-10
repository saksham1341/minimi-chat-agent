import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Conversation, type Meta } from "./api.ts";
import { Canvas } from "./components/Canvas.tsx";
import { Composer } from "./components/Composer.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Turn } from "./components/Turn.tsx";
import { apply, fromRecord, localDay, pending, type ViewTurn } from "./view.ts";

const MODEL_KEY = "chat.model";

const SUGGESTIONS = [
  "Compare managed Postgres hosts for a small SaaS: price, free tier, branching.",
  "What shipped in the last week in AI coding tools?",
  "What did I ask you yesterday? Is your answer still right?",
];

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ViewTurn[]>([]);
  const [modelId, setModelId] = useState<string | null>(localStorage.getItem(MODEL_KEY));
  const [drawer, setDrawer] = useState(false);
  const wide = useMedia("(min-width: 1180px)");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [canvasOpen, setCanvasOpen] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const refresh = useCallback(() => api.conversations().then(setConversations).catch(() => {}), []);

  useEffect(() => {
    api
      .meta()
      .then((m) => {
        setMeta(m);
        setModelId((id) => (id && m.models.some((x) => x.id === id) ? id : m.defaultModel));
      })
      .catch(() => setMetaError("Can't reach the server. Is `npm start` still running?"));
    refresh();
  }, [refresh]);

  // Follow the answer as it streams, unless the person has scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const busy = turns.at(-1)?.status === "streaming";

  const open = async (id: string) => {
    controller.current?.abort();
    const { conversation, turns } = await api.conversation(id);
    setConversationId(conversation.id);
    setTurns(turns.map(fromRecord));
    setFocusId(null);
    setDrawer(false);
    stick.current = true;
  };

  const startNew = () => {
    controller.current?.abort();
    setConversationId(null);
    setTurns([]);
    setDrawer(false);
  };

  const send = async (message: string) => {
    if (!modelId || busy) return;
    // Not crypto.randomUUID: it exists only in secure contexts, and this page is often opened over
    // plain http on a LAN or tailnet address. This id only lives until the server assigns the real one.
    const local = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setTurns((all) => [...all, pending(local, message.trim())]);
    setFocusId(null);
    setCanvasOpen(true);
    stick.current = true;
    const abort = new AbortController();
    controller.current = abort;
    const update = (fn: (t: ViewTurn) => ViewTurn) => setTurns((all) => all.map((t, i) => (i === all.length - 1 ? fn(t) : t)));
    try {
      await api.chat({ conversationId: conversationId ?? undefined, message, modelId }, (event) => {
        if (event.type === "start") {
          setFocusId(event.turnId);
          setConversationId(event.conversation.id);
          if (!conversationId) refresh();
        }
        update((t) => apply(t, event));
        if (event.type === "done") refresh();
      }, abort.signal);
    } catch (error) {
      if (abort.signal.aborted) update((t) => ({ ...t, status: "done", text: t.text || "_Stopped._" }));
      else update((t) => ({ ...t, status: "error", error: (error as Error).message }));
    }
  };

  const chooseModel = (id: string) => {
    setModelId(id);
    localStorage.setItem(MODEL_KEY, id);
  };

  const now = meta ? new Date(meta.now) : new Date();
  const today = localDay(now.toISOString());
  // Every day this conversation has looked back at, so the spine shows where its answers came from.
  const recalled = [...new Set(turns.flatMap((t) => t.activity.flatMap((a) => (a.kind === "recall" ? a.days ?? [] : []))))];
  const current = conversations.find((c) => c.id === conversationId);
  // The canvas shows the focused turn, or the latest one that did any work worth drawing.
  const hasWork = (t: ViewTurn) => t.activity.some((a) => a.kind === "search" || a.kind === "recall") || t.shape !== "reply";
  const canvasTurn = turns.find((t) => t.id === focusId && hasWork(t)) ?? [...turns].reverse().find(hasWork);
  const showCanvas = wide && canvasOpen && !!canvasTurn;
  const labelOf = (id?: string) => meta?.models.find((m) => m.id === id)?.label;

  return (
    <div className={`shell${drawer ? " drawer-open" : ""}${showCanvas ? " has-canvas" : ""}`}>
      <Sidebar conversations={conversations} currentId={conversationId} today={today} recalled={recalled} onOpen={open} onNew={startNew} />
      <button className="scrim" aria-label="Close conversations" onClick={() => setDrawer(false)} tabIndex={drawer ? 0 : -1} />
      <main className="main">
        <header className="topbar">
          <button className="menu" onClick={() => setDrawer(true)} aria-label="Show conversations">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
          <h1 className="topbar-title">{current?.title ?? (turns.length ? turns[0].question : "New conversation")}</h1>
          <Clock now={now} />
        </header>

        <div
          className="scroller"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {turns.length ? (
            <div className="thread">
              {turns.map((t, i) => (
                <Turn
                  key={t.id}
                  turn={t}
                  last={i === turns.length - 1}
                  onPick={send}
                  modelLabel={labelOf(t.model)}
                  canvas={showCanvas}
                  focused={showCanvas && canvasTurn?.id === t.id}
                  onFocus={() => {
                    setFocusId(t.id);
                    setCanvasOpen(true);
                  }}
                />
              ))}
            </div>
          ) : (
            <Empty now={now} onPick={send} error={metaError} ready={!!modelId} />
          )}
        </div>

        <div className="dock">
          <Composer meta={meta} modelId={modelId} onModel={chooseModel} onSend={send} onStop={() => controller.current?.abort()} busy={busy} />
        </div>
      </main>
      {showCanvas && canvasTurn && (
        <Canvas turn={canvasTurn} onPick={send} canPick={canvasTurn.id === turns.at(-1)?.id} onClose={() => setCanvasOpen(false)} />
      )}
    </div>
  );
}

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const on = () => setMatches(list.matches);
    list.addEventListener("change", on);
    return () => list.removeEventListener("change", on);
  }, [query]);
  return matches;
}

function Clock({ now }: { now: Date }) {
  return (
    <time className="clock" dateTime={now.toISOString()} title="The agent's clock">
      {now.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
    </time>
  );
}

function Empty({ now, onPick, error, ready }: { now: Date; onPick: (text: string) => void; error: string | null; ready: boolean }) {
  return (
    <section className="empty">
      <h2 className="empty-date">
        <span className="empty-weekday">{now.toLocaleDateString(undefined, { weekday: "long" })}</span>
        {now.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}
      </h2>
      <p className="empty-line">
        Ask about anything that changes: prices, releases, news. I search the web, show where each fact came from, and remember what we
        talked about on which day.
      </p>
      {error ? (
        <p className="error">{error}</p>
      ) : (
        <ul className="suggestions">
          {SUGGESTIONS.map((s) => (
            <li key={s}>
              <button disabled={!ready} onClick={() => onPick(s)}>{s}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
