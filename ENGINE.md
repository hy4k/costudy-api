# CoStudy AI Engine

## Architecture (single RAG path)

```
Browser AI Deck
    │
    │  POST /api/ask-cma  { message, history, subject, mode }
    ▼
API (costudy-api)
    1. expandQuery (follow-ups) — free
    2. embedOne (cached)       — OpenAI embeddings
    3. match_documents RPC     — Supabase pgvector
    4. chatComplete            — OpenAI chat, Anthropic fallback
    ▼
{ answer, sources, model, provider }
```

**Do not** call `/api/search` then `/api/ask-cma` for chat — that double-embeds and burns quota.

| Route | Purpose |
|-------|---------|
| `GET /health` | Engine config + cache size |
| `POST /api/search` | Library vault only |
| `POST /api/ask-cma` | Tutor chat (owns RAG) |
| `POST /api/summarize` | Wall post summaries |
| `POST /api/essay/evaluate` | Essay grading + light RAG |
| `POST /api/mcq/practice` | Practice MCQs from bank or chunks |
| `POST /api/admin/question-bank/extract` | Build bank from chunks |

## Fix OpenAI quota (production 429)

1. Open [OpenAI billing](https://platform.openai.com/account/billing) and add payment / credits.
2. Confirm `OPENAI_API_KEY` on the API host is the paid project key.
3. Restart the API process.
4. Optional: set `ANTHROPIC_API_KEY` so chat can fall back when OpenAI chat is down  
   (embeddings still require OpenAI unless you change embed provider later).
5. Smoke test:

```bash
curl -s https://api.costudy.in/health | jq
curl -s -X POST https://api.costudy.in/api/ask-cma \
  -H "Content-Type: application/json" \
  -d '{"message":"What is contribution margin?","subject":"CMA Part 1"}' | jq
```

## Question bank pipeline

1. Run SQL: `sql/practice_question_bank.sql` in Supabase.
2. Set `ADMIN_API_KEY` on the API host.
3. Extract:

```bash
# dry run
curl -s -X POST https://api.costudy.in/api/admin/question-bank/extract \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  -d '{"limit":100,"offset":0,"dryRun":true}' | jq

# write
curl -s -X POST https://api.costudy.in/api/admin/question-bank/extract \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  -d '{"limit":500,"offset":0}' | jq
```

Or offline:

```bash
node scripts/extract-question-bank.mjs --limit 500 --dry-run
node scripts/extract-question-bank.mjs --limit 500
```

4. Practice endpoint prefers the bank, then falls back to RAG over `content_chunks`.

## Deploy checklist

- [ ] `.env` from `.env.example` on API host
- [ ] OpenAI billing active
- [ ] Redeploy `costudy-api` with this engine
- [ ] Frontend uses updated `geminiService` (single path)
- [ ] Run practice bank SQL + extract
