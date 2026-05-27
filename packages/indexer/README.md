# @nebgov/indexer

Off-chain governance event indexer for NebGov.

## Quick start

```bash
cp .env.example .env
# Edit .env with your governor contract address
docker-compose up -d
```

## Database migrations

Indexer tables are managed with [node-pg-migrate](https://github.com/salsita/node-pg-migrate). Migration files live in `packages/indexer/migrations/` (numbered SQL with `-- Up Migration` / `-- Down Migration` sections). Applied migrations are stored in `pgmigrations_nebgov_indexer` so the indexer can share a PostgreSQL instance with the backend without conflicting migration history.

Migrations run automatically when the indexer process starts (`initDb()`).

**Apply pending migrations manually**

```bash
cd packages/indexer
npm install
npm run migrate
```

Uses `DATABASE_URL` from the environment (same variable as the backend).

**Rollback**

```bash
# Roll back the latest indexer migration
npm run migrate:down

# Roll back the latest N migrations
npx tsx src/migrate.ts down N
```

Then run `npm run migrate` to apply pending UP migrations again.

## API endpoints

- `GET /health` — health check with indexing lag metrics
- `GET /proposals?offset=0&limit=20` — paginated proposal list
- `GET /proposals/:id/votes` — votes for a specific proposal
- `GET /delegates?top=20` — top delegates by delegator count
- `GET /profile/:address` — governance activity for an address

## Health Check Endpoint

The `/health` endpoint provides comprehensive indexer health information:

```json
{
  "status": "ok",
  "last_indexed_ledger": 54321,
  "current_ledger": 54325,
  "lag_ledgers": 4,
  "lag_seconds": 20,
  "total_proposals_indexed": 12,
  "total_votes_indexed": 87,
  "total_delegates_indexed": 34,
  "uptime_seconds": 3600,
  "timestamp": "2026-04-23T12:00:00Z"
}
```

### Status Codes

- `200 OK` — Indexer is healthy and lag is within threshold
- `503 Service Unavailable` — Indexer is degraded (lag exceeds threshold or error occurred)

### Configuration

Set `HEALTH_LAG_THRESHOLD` environment variable to configure when the indexer is considered degraded (default: 100 ledgers).

```bash
HEALTH_LAG_THRESHOLD=100
```
