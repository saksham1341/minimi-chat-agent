/** Markdown with [S#] citations turned into source chips that show where a fact came from. */
import { useId, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Source } from "../api.ts";

/** `[S3]`, `[S3 "exact words"]`, `[S3 !"words not found in the source"]`, `[S1, S3]`. */
const MARKER = /\[(S\d[0-9a-f]*)(?:\s+(!?)"((?:[^"\\]|\\.)*)")?((?:\s*,\s*S\d[0-9a-f]*)*)\]/g;

interface Quote {
  quote?: string;
  verified?: boolean;
}

/**
 * Each marker becomes a link the renderer hands to <Cite>, carrying an index into `quotes` for its
 * quoted words. A marker still being typed at the end of a streaming answer is hidden, so the
 * screen never shows half a quote.
 */
const linkCitations = (text: string, quotes: Quote[]) =>
  text
    .replace(/\[S\d[0-9a-f]*[^\]\n]*$/, "")
    .replace(MARKER, (_m, id: string, bang: string, quote: string | undefined, rest: string) => {
      const i = quotes.push(quote === undefined ? {} : { quote: quote.replace(/\\(.)/g, "$1"), verified: bang !== "!" }) - 1;
      const more = (rest ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      return [`[${id}](#cite-${id}-${i})`, ...more.map((x) => `[${x}](#cite-${x})`)].join("");
    })
    // Anything else that names a source in brackets still reads as a citation, never as raw text.
    .replace(/\[(S\d[0-9a-f]*)\b[^\]\n]*\](?!\()/g, (_m, id: string) => `[${id}](#cite-${id})`);

export function Prose({ text, sources, className }: { text: string; sources: Source[]; className?: string }) {
  const quotes: Quote[] = [];
  const linked = linkCitations(text, quotes);
  return (
    <div className={className ?? "prose"}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            href?.startsWith("#cite-") ? (
              <Cite id={href.slice(6).split("-")[0]} sources={sources} {...(quotes[Number(href.split("-")[2])] ?? {})} />
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
        }}
      >
        {linked}
      </Markdown>
    </div>
  );
}

/**
 * A citation marker, like a footnote on Wikipedia. Pointing at it (or focusing it) previews the
 * source: site, title, date and the passage the answer drew on. On a touch screen, where there is
 * no hover, a tap opens the same preview as a bottom sheet with a button to open the page.
 */
export function Cite({ id, sources, quote, verified }: { id: string; sources: Source[]; quote?: string; verified?: boolean }) {
  const source = sources.find((s) => s.id === id);
  const key = useId();
  const open = useSyncExternalStore(preview.subscribe, () => preview.current?.key === key);
  const anchor = useRef<HTMLAnchorElement>(null);
  const pointer = useRef<string>("mouse");
  if (!source) return <span className="cite cite-missing">?</span>;
  const label = String(source.n ?? id.slice(1));

  const show = (mode: Mode) => anchor.current && preview.show({ key, source, quote, verified, rect: anchor.current.getBoundingClientRect(), mode });
  return (
    <>
      <a
        ref={anchor}
        className={`cite${open ? " is-open" : ""}${verified === false ? " is-unverified" : ""}`}
        href={source.url}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={`Source ${label}: ${source.title}, ${source.domain}`}
        aria-expanded={open}
        onPointerDown={(e) => (pointer.current = e.pointerType)}
        // Real phones always fire touch events for a finger; pointerType alone has proved unreliable.
        onTouchStart={() => (pointer.current = "touch")}
        onPointerEnter={(e) => e.pointerType === "mouse" && preview.soon(() => show("hover"))}
        onPointerLeave={(e) => e.pointerType === "mouse" && preview.later()}
        // Keyboard focus previews; focus that comes with a tap or click is handled on click.
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && show("hover")}
        onBlur={() => preview.later()}
        onClick={(e) => {
          // A finger has no hover, so the tap itself previews (as a sheet) and the sheet's
          // button opens the page. Decided by what tapped, not by what the screen claims.
          const finger = pointer.current === "touch" || pointer.current === "pen" || !matchMedia("(hover: hover)").matches;
          pointer.current = "mouse";
          if (finger) {
            e.preventDefault();
            show("sheet");
          }
        }}
      >
        {label}
      </a>
      {open && preview.current && createPortal(<Preview {...preview.current} />, document.body)}
    </>
  );
}

type Mode = "hover" | "sheet";
interface Shown {
  key: string;
  source: Source;
  quote?: string;
  verified?: boolean;
  rect: DOMRect;
  mode: Mode;
}

/** One preview open at a time, shared by every marker on the page. */
const preview = (() => {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const api = {
    current: null as Shown | null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: Shown | null) {
      clearTimeout(timer);
      api.current = next;
      listeners.forEach((l) => l());
    },
    show(next: Shown) {
      api.set(next);
    },
    soon(fn: () => void) {
      clearTimeout(timer);
      timer = setTimeout(fn, 160);
    },
    later() {
      clearTimeout(timer);
      timer = setTimeout(() => api.set(null), 140);
    },
    hold() {
      clearTimeout(timer);
    },
  };
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", (e) => e.key === "Escape" && api.set(null));
    window.addEventListener("scroll", () => api.current?.mode === "hover" && api.set(null), true);
  }
  return api;
})();

function Preview({ source, quote, verified, rect, mode }: Shown) {
  const body = (
    <>
      <span className="preview-site">
        <span className="preview-initial" aria-hidden>{source.domain.slice(0, 1).toUpperCase()}</span>
        {source.domain}
        {source.published && <span className="preview-date">{formatDay(source.published)}</span>}
      </span>
      <span className="preview-title">{source.title}</span>
      {quote ? (
        <>
          <span className="preview-quote">“{quote}”</span>
          <span className={`preview-check${verified === false ? " is-bad" : ""}`}>
            {verified === false ? "This quote wasn't found on the page; treat the claim as unverified." : "Quoted from the page as it read when answered."}
          </span>
        </>
      ) : (
        source.snippet && <span className="preview-snippet">{source.snippet}</span>
      )}
    </>
  );

  if (mode === "sheet") {
    return (
      <div className="cite-sheet-scrim" onClick={() => preview.set(null)}>
        <div className="cite-sheet" role="dialog" aria-label={`Source: ${source.title}`} onClick={(e) => e.stopPropagation()}>
          <span className="sheet-grip" aria-hidden />
          {body}
          <a className="preview-open" href={source.url} target="_blank" rel="noreferrer noopener">
            Open {source.domain}
          </a>
        </div>
      </div>
    );
  }

  // Above the marker when there is room, below when not; kept inside the window sideways.
  const width = Math.min(336, innerWidth - 16);
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), innerWidth - width - 8);
  const above = rect.top > 230;
  const style = above ? { left, width, bottom: innerHeight - rect.top + 8 } : { left, width, top: rect.bottom + 8 };
  return (
    <span className={`cite-preview${above ? " is-above" : ""}`} style={style} role="tooltip" onPointerEnter={() => preview.hold()} onPointerLeave={() => preview.later()}>
      {body}
    </span>
  );
}

export function formatDay(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The ids an answer actually cites, in order of first use. */
export function citedIds(...texts: string[]): string[] {
  const seen: string[] = [];
  for (const text of texts) for (const m of text.matchAll(/S\d[0-9a-f]*/g)) if (!seen.includes(m[0])) seen.push(m[0]);
  return seen;
}
