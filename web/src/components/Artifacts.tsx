/**
 * The structured answers, one component per shape. Each draws from partial data while it is
 * still streaming in, so a table fills row by row instead of appearing at the end.
 */
import type { Source } from "../api.ts";
import { Cite, formatDay, plainTopics, Prose } from "./Prose.tsx";

const plainDeep = (value: unknown): unknown =>
  typeof value === "string"
    ? plainTopics(value)
    : Array.isArray(value)
      ? value.map(plainDeep)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainDeep(v)]))
        : value;

type Partial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? Partial<U>[] : T[K] };

interface ComparisonData { title: string; columns: string[]; rows: { name: string; url?: string; cells: string[]; sources: Ref[] }[]; takeaway: string }
interface ChangesData { title: string; since: string; items: { subject: string; status: "changed" | "unchanged" | "corrected" | "new" | "unverified"; before?: string; now?: string; note?: string; sources: Ref[] }[]; summary: string }
interface ChoicesData { question: string; options: { label: string; reply: string }[] }

export function Artifact(raw: { shape: string; answer: unknown; sources: Source[]; live: boolean; onPick: (reply: string) => void; canPick: boolean }) {
  if (!raw.answer || typeof raw.answer !== "object") return null;
  // Every string in a card, topic marks shown as plain words (they are for memory, not the reader).
  const props = { ...raw, answer: plainDeep(raw.answer) };
  if (props.shape === "comparison") return <ComparisonCard data={props.answer as Partial<ComparisonData>} sources={props.sources} live={props.live} />;
  if (props.shape === "changes") return <ChangesCard data={props.answer as Partial<ChangesData>} sources={props.sources} />;
  if (props.shape === "choices") return <ChoicesCard data={props.answer as Partial<ChoicesData>} onPick={props.onPick} canPick={props.canPick && !props.live} />;
  return null;
}

type Ref = string | { id?: string; quote?: string; verified?: boolean };

/** A card's source entries as citation chips: plain ids, or ids with the words they rest on. */
const Chips = ({ ids, sources }: { ids?: Ref[]; sources: Source[] }) =>
  ids?.length ? (
    <span className="chips">
      {ids.map((ref, i) =>
        typeof ref === "string" ? (
          <Cite key={`${ref}-${i}`} id={ref} sources={sources} />
        ) : ref?.id ? (
          <Cite key={`${ref.id}-${i}`} id={ref.id} sources={sources} quote={ref.quote} verified={ref.verified} />
        ) : null,
      )}
    </span>
  ) : null;

function ComparisonCard({ data, sources, live }: { data: Partial<ComparisonData>; sources: Source[]; live: boolean }) {
  const columns = data.columns ?? [];
  return (
    <figure className="card card-comparison">
      {data.title && <figcaption className="card-title">{data.title}</figcaption>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col"><span className="visually-hidden">Option</span></th>
              {columns.map((c, i) => <th key={i} scope="col">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {(data.rows ?? []).map((row, r) => (
              <tr key={r}>
                <th scope="row">
                  {row.url ? <a href={row.url} target="_blank" rel="noreferrer noopener">{row.name}</a> : row.name}
                  <Chips ids={row.sources} sources={sources} />
                </th>
                {columns.map((_, c) =>
                  row.cells?.[c] !== undefined ? <td key={c}>{row.cells[c]}</td> : <td key={c} className={live ? "is-pending" : ""} />,
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.takeaway && <Prose className="prose card-foot" text={data.takeaway} sources={sources} />}
    </figure>
  );
}

const STATUS: Record<string, string> = { changed: "Changed", corrected: "Correction", new: "New", unchanged: "No change", unverified: "Couldn't verify" };

function ChangesCard({ data, sources }: { data: Partial<ChangesData>; sources: Source[] }) {
  return (
    <figure className="card card-changes">
      <figcaption className="card-title">
        {data.title}
        {data.since && <span className="card-since">since {formatDay(data.since)}</span>}
      </figcaption>
      <ul className="changes">
        {(data.items ?? []).map((item, i) => (
          <li key={i} className={`change status-${item.status ?? "pending"}`}>
            <span className="change-status">{STATUS[item.status ?? ""] ?? "Checking"}</span>
            <div className="change-body">
              <span className="change-subject">
                {item.subject}
                <Chips ids={item.sources} sources={sources} />
              </span>
              {(item.before || item.now) && (
                <span className="change-values">
                  {(item.status === "changed" || item.status === "corrected") && item.before && item.now && item.before !== item.now ? (
                    <>
                      <del>{item.before}</del>
                      <span className="change-arrow" aria-label="now">to</span>
                      <ins>{item.now}</ins>
                    </>
                  ) : (
                    <span>{item.now ?? item.before}</span>
                  )}
                </span>
              )}
              {item.note && <span className="change-note">{item.note}</span>}
            </div>
          </li>
        ))}
      </ul>
      {data.summary && <Prose className="prose card-foot" text={data.summary} sources={sources} />}
    </figure>
  );
}

function ChoicesCard({ data, onPick, canPick }: { data: Partial<ChoicesData>; onPick: (reply: string) => void; canPick: boolean }) {
  return (
    <div className="choices">
      {data.question && <p className="choices-question">{data.question}</p>}
      <div className="choices-options">
        {(data.options ?? []).map((o, i) => (
          <button key={i} className="choice" disabled={!canPick || !o.reply} onClick={() => o.reply && onPick(o.reply)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
