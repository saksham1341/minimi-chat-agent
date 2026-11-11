# A chat agent that knows what day it is, and shows its evidence

```bash
cp .env.example .env    # a model (Anthropic API or AWS Bedrock) and a search key (Exa or Tavily)
npm install
npm start               # http://localhost:3000  (HOST=0.0.0.0 to open it to your network)
```

Node 22.13+. Every variable it reads is in `.env.example`; startup prints what it found. How it fits together, in more depth: [`DESIGN.md`](DESIGN.md).

## How it works

The brief's questions ("On Monday we shortlisted 5 CRM tools… changed since?") need **the right earlier exchange, what it said, and evidence about now**. The model writes the metadata; software does the matching and checking.

1. **Indexing, in two steps.** The answer marks its main topics inline (`[[Neon]]`, hidden on screen), so a default card is saved the moment it is done. Then a background run writes the full index card: a summary, the entities and topics with the ways people say them ("Postgres hosting" is also "db hosts", "managed database"), and the facts stated with their quotes, with the conversation so far and what memory matched as context.
2. **Resolving a reference, in software.** Every past day's names are generated from the calendar ("yesterday", "last tuesday", "3 november", "a week or so back") and matched, with the cards' terms, against the message's word sequences. The model gets the likely exchanges with their age, a stated confidence and reason, and their original facts as the baseline, plus the last week's exchanges as one-line summaries from their cards (never bare titles, which a model fills in with memories it never had).
3. **Re-checking by quote.** For a confident match, software re-reads the pages the original facts came from and looks each quote up word for word (still there, or gone with the closest passage now) before the model starts.
4. **The run.** The agent runtime (`src/agents/`) holds the loop, the models and every credential, and reaches the one tool, `web_search`, only over MCP. The `answer_*` calls are not tools: they hand over a structured answer, since tool arguments are where providers enforce a schema.
5. **Citations found, then checked.** The answer only tags each fact with its page, `[S3f2a1]`. As each paragraph is written, a short run on a light model (Haiku) finds the exact words in that page's passage that state the claim, attached while the answer streams. A quote must be in the passage and state the sentence's figure, or it shows as unverified. Nothing is sent back for a rewrite.
6. **Answers as a trust boundary.** Later turns replay each question and the answer as given, citations tagged, without the pages. When a follow-up needs more of a cited page, the model reads it back by id (`web_search` with `pages`), as kept that day or live.
7. **Working in the open.** What the model writes before a search shows as working notes, folded away when the answer lands. A message sent meanwhile joins the run after its next round of searches; later, it goes as the next question.

## Why

- **Each does what it is good at.** Recognising what was discussed and finding the words that support a claim are language tasks, done by models. Matching, quote lookups and evidence dates have right answers, so software does them in milliseconds, with tests for the cases that once failed.
- **A driver and a backend.** The runtime holds the models and keys and reaches the backend only over MCP, as any agent would: point Claude Code at `/mcp` and it gets the same search. The backend never holds a model key. It runs in-process by default or as its own deployment (`APP_AGENTS=remote`). Inside the backend: ports and adapters, import direction enforced by a test.
- **Feeling fast is design too.** Activity shows in under 0.1 s, working notes from about 2 s, and search lanes as the model types each query.

Measured on Sonnet 4.5 (answers) and Haiku 4.5 (citations, index cards) via Bedrock: memory-only answers 4–7 s; a searched answer about 17 s, its last citations about 3 s later; a fresh comparison about 35 s.

## Considered and rejected

- **A recall tool or router model:** each is a model round the person waits for. Indexing is a model call too, but after the answer.
- **Indexing, or quoting, in the answering response:** no extra call, but the person waits for it, and a citation wrong in form cost a rewrite.
- **A date grammar or LLM date parser:** grammars miss unwritten phrasings; generated day names need neither.
- **Embeddings:** the card's aliases carry the meaning, and exact matching is explainable and testable.
- **Provider-native citations:** Claude-only; checked quotes work with any model.
- **Replaying whole search results:** one question brought back over 100 KB of pages, re-sent with every follow-up.
- **More thinking on re-checks:** 15–20 s more for the same verdict.

## With another week

- **Evals:** dated multi-session scripts on a frozen clock, scoring resolution, quote validity and verdicts.
- **Search planning on a faster light model:** built (`PLAN_SEARCHES`), off because Bedrock Haiku plans no faster than Sonnet's own first round.
- **Scheduled re-checks of the ledger** with the same quote diff.
- **Sign-in and per-person memory.**
