/**
 * The citation run: a second agent run, started as soon as the answer's first paragraph is
 * written, that attaches evidence to the answer while the answer is still being written.
 *
 * The answering model only tags each fact with the page it came from (`[S3f2a1]`), which is less
 * to write and nothing to get wrong in form. Each paragraph, as soon as it is written, gets its own
 * short run on the light model, reading exactly the passages the answering model read for the
 * pages that paragraph tags, and nothing else. Paragraphs are independent, so their runs go in
 * parallel: a chain of runs, one continuing the last, was measured waiting 9 s after the answer
 * ended for continuity a citation does not need. A paragraph with no tags has nothing to cite. For each claim it finds the words on a page that state it, on the
 * tagged page or, when the tag was wrong, on another. Software attaches them
 * (`domain/citations.ts`) and checks every quote against the passages as before.
 *
 * It replaces the round that used to send a whole answer back to fix its citations. The answer
 * is on screen, and done, as soon as it is written; citations fill in behind it.
 */
import { asked } from "../agents/conversation.ts";
import { CITATIONS_SHAPE } from "../domain/answers.ts";
import { Citations, type Citation } from "../domain/citations.ts";
import type { AgentRuntimePort } from "../ports/runtime.ts";

export const CITE_INSTRUCTION = `You attach evidence to an answer while it is being written. You are given the question, the passages the writer read for the pages one part of the answer tags (each under its page id), and that part. Call answer_citations once, with every checkable claim in the part: figures, prices, dates, versions, plan names, limits, statements of fact.

- after: the exact words of the answer that end the claim, 3 to 12 words copied character for character, stopping before any [S…] tag that follows them.
- sources: for each page whose passage states the claim, its id and the words from that passage that state it, including the figure, copied character for character (5 to 30 words; use ... for words you leave out). Prefer the page the writer tagged; if its passage does not say it, use another passage that does; if none does, leave sources empty. Never cite a page for something its passage does not say.

A part with nothing checkable gets an empty list. Write nothing else.`;

export interface Page {
  id: string;
  title: string;
  domain: string;
  text: string;
}

export class Citer {
  constructor(private readonly deps: { runtime: AgentRuntimePort; log: (message: string) => void }) {}

  /** A session for one answer. `onFound` gets everything found so far, each time more is. */
  begin(o: { model: string; question: string; onFound: (found: Citation[]) => void }): CiteSession {
    return new CiteSession(this.deps, o);
  }
}

export class CiteSession {
  private readonly found: Citation[] = [];
  private readonly runs: Promise<void>[] = [];
  private readonly controller = new AbortController();
  private readonly started = Date.now();

  constructor(
    private readonly deps: { runtime: AgentRuntimePort; log: (message: string) => void },
    private readonly o: { model: string; question: string; onFound: (found: Citation[]) => void },
  ) {}

  /** A finished paragraph and the passages of the pages it tags: cited in its own run, now. */
  push(part: string, pages: Page[]) {
    if (!pages.length || this.controller.signal.aborted) return;
    this.runs.push(this.cite(part, pages));
  }

  get parts(): number {
    return this.runs.length;
  }

  /** Every citation found once the paragraphs given are done, or by the deadline. */
  async finish(deadlineMs: number): Promise<Citation[]> {
    const late = await Promise.race([Promise.all(this.runs).then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), deadlineMs))]);
    if (late) this.controller.abort();
    this.deps.log(`cite: ${this.runs.length} paragraphs, ${this.found.length} claims cited, ${((Date.now() - this.started) / 1000).toFixed(1)}s${late ? " (cut at the deadline)" : ""}`);
    return [...this.found];
  }

  /** The text turned out to be working notes before a search: drop this session. */
  abort() {
    this.controller.abort();
  }

  private async cite(part: string, pages: Page[]) {
    // A few at a time: the light model is shared with the indexer, and a provider throttles bursts.
    await slots.take();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.once(part, pages);
        } catch (error) {
          const throttled = /429|too many requests|throttl/i.test((error as Error).message);
          if (!throttled || attempt >= 3 || this.controller.signal.aborted) throw error;
          await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        }
      }
    } catch (error) {
      if (!this.controller.signal.aborted) this.deps.log(`cite: a paragraph failed (${(error as Error).message})`);
    } finally {
      slots.give();
    }
  }

  private async once(part: string, pages: Page[]) {
    const ask = [`<question>\n${this.o.question}\n</question>`, "", "The passages the writer read for this part:", "", ...pages.map(page), "", "The part of the answer:", "", part].join("\n");
    const events = this.deps.runtime.run(
      {
        runId: crypto.randomUUID(),
        model: this.o.model,
        instruction: CITE_INSTRUCTION,
        history: [],
        ask: asked(ask),
        endings: [{ name: CITATIONS_SHAPE.name, description: CITATIONS_SHAPE.description, schema: CITATIONS_SHAPE.schema }],
        maxRounds: 1,
        tools: false,
      },
      this.controller.signal,
    );
    for await (const event of events) {
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "done" && event.shape === CITATIONS_SHAPE.name) {
        const parsed = Citations.safeParse(event.answer);
        if (parsed.success && parsed.data.citations.length && !this.controller.signal.aborted) {
          this.found.push(...parsed.data.citations);
          this.o.onFound([...this.found]);
        }
      }
    }
  }
}

/** Citation runs in flight across the server: enough to keep up with an answer, few enough not to be throttled. */
const slots = (() => {
  let free = 3;
  const waiting: (() => void)[] = [];
  return {
    take: () => (free > 0 ? (free--, Promise.resolve()) : new Promise<void>((r) => waiting.push(r))),
    give: () => {
      const next = waiting.shift();
      if (next) next();
      else free++;
    },
  };
})();

const page = (p: Page) => `[${p.id}] ${p.title} (${p.domain})\n${p.text.trim()}\n`;
