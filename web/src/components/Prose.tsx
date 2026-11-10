/** Markdown with [S#] citations turned into source chips that show where a fact came from. */
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Source } from "../api.ts";

const CITE = /\[(S\d+(?:\s*,\s*S\d+)*)\]/g;

/** "[S1, S3]" → "[S1](#cite-S1)[S3](#cite-S3)", so the markdown renderer hands each to <Cite>. */
const linkCitations = (text: string) =>
  text.replace(CITE, (_, ids: string) =>
    ids
      .split(",")
      .map((id) => `[${id.trim()}](#cite-${id.trim()})`)
      .join(""),
  );

export function Prose({ text, sources, className }: { text: string; sources: Source[]; className?: string }) {
  return (
    <div className={className ?? "prose"}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            href?.startsWith("#cite-") ? (
              <Cite id={href.slice(6)} sources={sources} />
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
        }}
      >
        {linkCitations(text)}
      </Markdown>
    </div>
  );
}

export function Cite({ id, sources }: { id: string; sources: Source[] }) {
  const source = sources.find((s) => s.id === id);
  if (!source) return <span className="cite cite-missing">{id.slice(1)}</span>;
  return (
    <a className="cite" href={source.url} target="_blank" rel="noreferrer noopener" aria-label={`Source: ${source.title}, ${source.domain}`}>
      {id.slice(1)}
      <span className="cite-card" role="tooltip">
        <span className="cite-domain">{source.domain}</span>
        <span className="cite-title">{source.title}</span>
        {source.published && <span className="cite-date">Published {formatDay(source.published)}</span>}
      </span>
    </a>
  );
}

export function formatDay(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The ids an answer actually cites, in order of first use. */
export function citedIds(...texts: string[]): string[] {
  const seen: string[] = [];
  for (const text of texts) for (const m of text.matchAll(/S\d+/g)) if (!seen.includes(m[0])) seen.push(m[0]);
  return seen;
}
