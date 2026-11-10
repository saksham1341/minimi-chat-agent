# A chat agent that knows what day it is, and shows its evidence

```bash
cp .env.example .env    # a model (Anthropic API or AWS Bedrock) and a search key (Exa or Tavily)
npm install
npm start               # http://localhost:3000  (HOST=0.0.0.0 to open it to your network)
```

Node 22.13+. Every variable it reads is in `.env.example`; startup prints what it found.

## How it works

The brief's questions ("On Monday we shortlisted 5 CRM tools… changed since?") need **a date, a memory of what was said that day, and evidence about now**. A turn (`src/services/chat.ts`):

1. **Recall, in code, before the model, with no trigger phrases.** "Monday", "3 November", "last Tuesday" become instants in the person's time zone (`domain/time.ts`, tested). Those days' exchanges go into a `<context>` block on the message, along with exchanges sharing the message's *rare* words (SQLite FTS5; a word counts only if few past exchanges contain it, so "now" or "thing" never match). Each comes with the facts stated then and the source words they came from. A named day with nothing on it is said plainly. Whether any of it matters is the model's call.
2. **Reading ahead.** When a named day brings back earlier facts, the harness starts reading each vendor's own page live, plus its "announcements since" news, in the background as the model starts. If the model then searches for those, the answer is already there (measured: ten re-check searches in 0.0 s of tool time); if not, the reads are dropped.
3. **The loop** (`agents/loop.ts`, ported from my framework Keel). The model's one tool, `web_search`, comes over MCP from the search service. Parallel calls return in one message, failures come back as results, and there is a round budget with a hard cap. A tool call written as text is caught and redone.
4. **Answers have shapes.** Plain prose, or a comparison, a what-changed report or a clarifying question. Those are tool calls whose schema-checked arguments are the answer, each with a `headline`. They stream into a live canvas.
5. **Citations are quotes, and the harness checks them.** The model cites with the exact words it relied on, `[S1 "$1.50/branch-month"]`, several per claim if several sources agree. The harness keeps each source's text as a snapshot and checks every quote against it. Numbering carries across a conversation, so a follow-up can cite the last answer's pages. Malformed citations, ones standing in for the fact, or many misses send prose back once. Otherwise misses are shown flagged; a card is never rewritten for a quote. A "changed" or "corrected" verdict must cite a page read live, on the vendor's own domain (hubspot.com for HubSpot, never an aggregator), or published after the baseline. An "unchanged" with nothing current behind it is shown unverified.
6. **The ledger** stores each stated fact with its source, quote and date, so the next "is it still correct?" compares words, not memories.

## Why

- **Compute what is computable; leave judgement to the model.** Dates, quote matching and evidence dates have right answers, so code does them in milliseconds, and tests check them. Whether memory is relevant and whether something changed are judgements, so they are the model's, within those checks.
- **Ports and adapters** (Keel's layering). The runtime (`agents/`) imports nothing of the app. Then `domain/` (no I/O), `ports/` + `adapters/` (Bedrock, Anthropic, Exa, Tavily, SQLite), `services/`, thin `api/` (HTTP for people, MCP for agents) and `assembly.ts`. A test enforces the import direction. A missing key is a named adapter that refuses honestly.
- **Tools over MCP** means the agent's capabilities are whatever server `MCP_ENDPOINT` names: this process by default, at a cost of milliseconds.
- **The model picker is the adapter list.** Models are registered only when their keys are set, and switching models mid-conversation is safe.

Measured on Sonnet 4.5 via Bedrock:
- First activity on screen: under 0.1 s. A placeholder is there from the first frame, the model's own working note shows in the status line, and search lanes appear as it types the query.
- Memory-only answers: 3–8 s. Searched answers and follow-ups: 15–25 s.
- Comparisons: about 45 s. Re-checks: 40–55 s, most of it the model writing the card, which streams in from about 12 s.

## Considered and rejected

- **A recall tool or a router model.** Either adds a model round before anything useful, for arithmetic.
- **An LLM to parse dates.** Slower, and wrong about weekdays.
- **Embeddings.** Questions name products and days, which FTS and date ranges match exactly.
- **Provider-native citations.** Claude-only, and uncertain on Bedrock's older API version. Checked quotes work with any model.
- **More thinking on re-checks.** Tried it: +15–20 s and the same verdict. The harness's evidence rules fixed the false "changed" calls.
- **All of Keel.** Tenancy, proposals and jobs are for multi-user systems; only the layering and its rules came over.

## With another week

- **Evals:** dated multi-session scripts on a frozen clock, scoring date resolution, recall, quote validity and verdicts.
- **A faster model for writing cards**, routed per shape: card writing is now most of the wait.
- **Scheduled re-checks of the ledger.**
- **Sign-in and per-person memory.**
- **Conversation compaction.**
