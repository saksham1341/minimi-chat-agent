/** Where the person types, picks the model, and stops an answer they no longer need. */
import { useEffect, useRef, useState } from "react";
import type { Meta } from "../api.ts";
import { Chevron } from "./Trail.tsx";

export function Composer(props: {
  meta: Meta | null;
  modelId: string | null;
  onModel: (id: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
}) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    if (!props.busy) area.current?.focus();
  }, [props.busy]);

  const send = () => {
    if (!text.trim() || props.busy || !props.modelId) return;
    props.onSend(text);
    setText("");
  };

  const noModels = props.meta && !props.meta.models.length;
  return (
    <div className="composer">
      <label className="visually-hidden" htmlFor="message">Message</label>
      <textarea
        id="message"
        ref={area}
        rows={1}
        value={text}
        placeholder={noModels ? "Add ANTHROPIC_API_KEY to .env and restart to start chatting" : "Ask about anything current"}
        disabled={!!noModels}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-row">
        <ModelPicker meta={props.meta} modelId={props.modelId} onModel={props.onModel} />
        {props.meta && !props.meta.search.available && <span className="composer-warning">Web search is off: add EXA_API_KEY or TAVILY_API_KEY</span>}
        {props.busy ? (
          <button className="send is-stop" onClick={props.onStop} aria-label="Stop answering">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" /></svg>
          </button>
        ) : (
          <button className="send" onClick={send} disabled={!text.trim() || !props.modelId} aria-label="Send">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden><path d="M8 13V3.5M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}

function ModelPicker({ meta, modelId, onModel }: { meta: Meta | null; modelId: string | null; onModel: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const models = meta?.models ?? [];
  const current = models.find((m) => m.id === modelId);
  if (!models.length) return <span className="picker-empty">No model configured</span>;
  return (
    <div className="picker" ref={box}>
      <button className="picker-button" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
        {current?.label ?? "Choose a model"}
        <Chevron open={open} />
      </button>
      {open && (
        <ul className="picker-menu" role="listbox" aria-label="Model">
          {models.map((m) => (
            <li key={m.id} role="option" aria-selected={m.id === modelId}>
              <button
                className={m.id === modelId ? "is-current" : ""}
                onClick={() => {
                  onModel(m.id);
                  setOpen(false);
                }}
              >
                <span className="picker-label">{m.label}</span>
                <span className="picker-hint">{m.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
