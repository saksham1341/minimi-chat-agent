# A chat agent that knows what day it is, and shows its evidence

```bash
cp .env.example .env    # a model (Anthropic API or AWS Bedrock) and a search key (Exa or Tavily)
npm install
npm start               # http://localhost:3000  (HOST=0.0.0.0 to open it to your network)
```

Node 22.13+. Every variable it reads is in `.env.example`; startup prints what it found.

## How it works

The brief's questions ("On Monday we shortlisted 5 CRM tools… changed since?") need **the right earlier exchange, what it said, and evidence about now**. The model writes the metadata; software does the matching and the checking.

1. **Indexing, in the same response.** When the model answers, it also writes the exchange's index card as structured output. The card holds what kind of exchange it was (new, re-check, follow-up), a summary, the entities and topics with every way a person might say them ("Postgres hosting" is also "db hosts", "managed database", "neon"), and the facts it stated with their quotes. There is no second model call.
2. **Resolving a reference, in software.** Every past day's names are generated from the calendar ("yesterday", "last tuesday", "3 november", "a week or so back"). These, and the cards' terms, are matched against the message's own word sequences; a term most exchanges share does not count. The model receives the exchanges the message most likely means, with a stated confidence and the reason, their original facts as the baseline, and a calendar of counts, never titles, so it cannot mistake a title for a memory. The composer previews this as you type.
3. **Re-checking by quote.** For a confident match, software re-reads the pages the original facts came from and looks each quote up word for word: still there, or gone (with the closest passage now). This happens before the model starts, in under ~4 s. The model judges what changed from that, and searches for anything it does not cover.
4. **The run.** The agent runtime (`src/agents/`) is a driver: the loop, the models and every model credential. It reaches the backend's one tool, `web_search`, only over MCP. Parallel calls return together, failures come back as results, rounds are capped, and a tool call written as text is caught and redone.
5. **Checked citations.** The model cites a page's stable id with the exact words it relied on: `[S3f2a1 "$1.50/branch-month"]`. The chat service keeps each page's text from what the run reports and checks every quote against it. Broken citations, or replies that talk about "the context", continue the run once with a correction. A "changed" verdict needs the vendor's own page, a live read or a dated source; an "unchanged" with nothing current behind it shows as unverified. Answers stream as prose or as comparison and what-changed cards into a live canvas.

## Why

- **Each does what it is good at.** Recognising what was discussed and how people will refer to it is a language task, done by the model that just answered. Matching, quote lookups and evidence dates have right answers, so software does them in milliseconds and tests encode the cases that once failed. The model keeps the judgement and can always search for more.
- **Keel's split: a driver and a backend.** The runtime holds the models and their keys and reaches the backend only over MCP, as any agent would: point Claude Code at `/mcp` and it gets the same search. The backend never holds a model key. It runs the runtime in-process by default, or as its own deployment (`APP_AGENTS=remote`, `npm run agents`); tests cross that boundary over real HTTP. Inside the backend, ports and adapters, with the import direction enforced by a test.
- **Feeling fast is design too.** Activity is on screen in under 0.1 s, then a placeholder, the model's working note, and search lanes that appear as the model types each query.

Measured on Sonnet 4.5 via Bedrock: memory-only answers 3–8 s; searched answers 15–25 s; comparisons about 35 s; a re-check that matched with confidence about 30 s, in one model round.

## Considered and rejected

- **A recall tool, a router model, or an indexing call:** each is a model round the person waits for, or pays for. The answering model writes the card in the same response.
- **A date grammar or an LLM date parser:** grammars miss phrasings nobody wrote a rule for. Generated day names need neither.
- **Embeddings:** the card's aliases carry the meaning, and exact matching against them is explainable and testable.
- **Provider-native citations:** Claude-only; checked quotes work with any model.
- **More thinking on re-checks:** it added 15–20 s and gave the same verdict; the quote diff settles most of it.

## With another week

- **Evals:** dated multi-session scripts on a frozen clock, scoring resolution, quote validity and verdicts.
- **A faster model for writing cards:** that is now most of the wait.
- **Scheduled re-checks of the ledger,** using the same quote diff.
- **Sign-in and per-person memory.**
- **Conversation compaction.**
