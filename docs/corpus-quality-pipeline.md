# CoStudy Corpus Quality Pipeline

This pipeline helps ingest large CMA US content sets while keeping only high-quality material.

## 1) Prepare input files

- Put one or more `.csv` files in:
  - `/root/costudy-frontend/migration-input/new-corpus`
- Use the template:
  - `docs/corpus-ingestion-template.csv`

## 2) Ingest to staging with auto-score

```bash
cd /root/costudy-api
set -a && source .env && set +a
node scripts/ingest-corpus-staging.js
```

What it does:
- Parses all CSV files in the corpus folder
- Scores each row (`quality_score` 0-100)
- Buckets into `APPROVE` / `REVIEW` / `REJECT`
- Stores rows in `ingestion_staging`

## 3) Auto-triage high and low quality rows

```bash
node scripts/auto-triage-staging.js
```

Defaults:
- `>= 80` -> `APPROVED`
- `< 60` -> `REJECTED`
- `60-79` stays `PENDING_REVIEW`

Override thresholds:

```bash
CORPUS_APPROVE_THRESHOLD=85 CORPUS_REJECT_THRESHOLD=65 node scripts/auto-triage-staging.js
```

## 4) Export manual review queue

```bash
node scripts/export-review-queue.js
```

Output:
- `/root/costudy-frontend/migration-input/new-corpus/review_queue.csv`

After review, update `ingestion_staging.status` rows to `APPROVED` or `REJECTED`.

## 5) Publish approved content

```bash
node scripts/publish-approved-corpus.js
```

Publish targets:
- `question_bank` (exam-ready content)
- `content_documents` + `content_chunks` (RAG content)

## 6) Backfill embeddings for newly published chunks

```bash
npm run backfill:embeddings
```

## Notes

- `license_ok=true` is required for high scores.
- Dedupe is enforced with `normalized_hash`.
- Publish is idempotent (safe to rerun).
