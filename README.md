# A chat agent that knows what day it is, and shows its evidence

```bash
cp .env.example .env    # a model (Anthropic API or AWS Bedrock) and a search key (Exa or Tavily)
npm install
npm start               # http://localhost:3000  (HOST=0.0.0.0 to open it to your network)
```

Node 22.13+. Every variable it reads is in `.env.example`; startup prints what it found.

## How it works

The brief's questions ("On Monday we shortlisted 5 CRM tools… changed since?") need **a date, a memory of what was said that day, and evidence about now**. A turn (`src/services/chat.ts`):

1. **Recall, in code, before the model.** "Monday", "3 November", "last Tuesday" become instants in the person's time zone (`domain/time.ts`, tested). Those days' exchanges and a full-text topic match (SQLite FTS5) go into a `<context>` block on the message, with the facts stated then and the source words each came from. If nothing matches, the block says so, so the agent does not invent a past.
2. **Re-checks start with the work done.** When an earlier answer's facts are recalled, the harness plans from its ledger one live re-read per source site, plus one "announcements since" search per vendor. These run in parallel before the model's first token.
3. **The loop** (`agents/loop.ts`, ported from my framework Keel). The model's one tool, `web_search`, comes over MCP from the search service. Parallel calls return in one message, failures come back as results, and there is a round budget with a hard cap. A tool call written as text is caught and redone.
4. **Answers have shapes.** Plain prose, or a comparison, a what-changed report or a clarifying question. Those are tool calls whose schema-checked arguments are the answer, each with a `headline`. They stream into a live canvas.
5. **Citations are quotes, and the harness checks them.** The model cites with the exact words it relied on, `[S1 "$1.50/branch-month"]`, several per claim if several sources agree. The harness keeps each source's text as a snapshot and checks every quote against it. Malformed citations, or ones standing in for the fact, go back to the model once. A few misses are shown flagged rather than rewritten. A "changed" or "corrected" verdict must cite a page read live, found on the vendor's own site, or published after the baseline.
6. **The ledger** stores each stated fact with its source, quote and date, so the next "is it still correct?" compares words, not memories.

## Why

- **Compute what is computable; leave judgement to the model.** Dates, recall, quote matching, evidence dates and re-read planning have right answers, so code does them in milliseconds, and tests check them. Whether something changed is the model's call, within those checks.
- **Ports and adapters** (Keel's layering). The runtime (`agents/`) imports nothing of the app. Then `domain/` (no I/O), `ports/` + `adapters/` (Bedrock, Anthropic, Exa, Tavily, SQLite), `services/`, thin `api/` (HTTP for people, MCP for agents) and `assembly.ts`. A test enforces the import direction. A missing key is a named adapter that refuses honestly.
- **Tools over MCP** means the agent's capabilities are whatever server `MCP_ENDPOINT` names: this process by default, at a cost of milliseconds.
- **The model picker is the adapter list.** Models are registered only when their keys are set, and switching models mid-conversation is safe.

Measured on Sonnet 4.5 via Bedrock: plain answers 5–10 s; searched answers 15–28 s, text from about 7 s. A re-check is about 40 s, most of it the model writing the card, but its re-reads land on screen within a second.

## Considered and rejected

- **A recall tool or a router model.** Either adds a model round before anything useful, for arithmetic.
- **An LLM to parse dates.** Slower, and wrong about weekdays.
- **Embeddings.** Questions name products and days, which FTS and date ranges match exactly.
- **Provider-native citations.** Claude-only, and uncertain on Bedrock's older API version. Checked quotes work with any model.
- **More thinking on re-checks.** Tried it: +15–20 s and the same verdict. The harness's evidence rules fixed the false "changed" calls.
- **All of Keel.** Tenancy, proposals and jobs are for multi-user systems; only the layering and its rules came over.

## With another week

- **Evals:** dated multi-session scripts on a frozen clock, scoring date resolution, recall, quote validity and verdicts.
- **A faster model for writing cards**, routed per shape.
- **Scheduled re-checks of the ledger.**
- **Sign-in and per-person memory.**
- **Conversation compaction.**
