# NebGov Backend API

## Competition Routes

### GET /competitions

Returns a paginated list of all competitions.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `is_active` | boolean | - | Filter by active status |
| `limit` | integer | 20 | Number of results (1-100) |
| `offset` | integer | 0 | Number of results to skip |

**Response:**
```json
{
  "competitions": [
    {
      "id": 1,
      "name": "Competition Name",
      "description": "Description",
      "entry_fee": "100",
      "start_date": "2025-01-01T00:00:00.000Z",
      "end_date": "2025-12-31T00:00:00.000Z",
      "is_active": true,
      "created_by": 1,
      "participant_count": 5
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

### GET /competitions/:id

Returns a single competition by ID.

**Authentication:** Optional (if authenticated, includes `is_joined` status)

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | integer | Competition ID |

**Response (unauthenticated):**
```json
{
  "competition": {
    "id": 1,
    "name": "Competition Name",
    "description": "Description",
    "entry_fee": "100",
    "start_date": "2025-01-01T00:00:00.000Z",
    "end_date": "2025-12-31T00:00:00.000Z",
    "is_active": true,
    "created_by": 1
  }
}
```

**Response (authenticated):**
```json
{
  "competition": { ... },
  "is_joined": true
}
```

### GET /competitions/:id/participants

Returns a paginated list of participants for a competition.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 20 | Number of results (1-100) |
| `offset` | integer | 0 | Number of results to skip |

**Response:**
```json
{
  "participants": [
    {
      "id": 1,
      "competition_id": 1,
      "user_id": 1,
      "joined_at": "2025-01-01T00:00:00.000Z",
      "entry_fee_paid": "100",
      "wallet_address": "0x123..."
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

### POST /competitions/:id/join

Join a competition. Requires authentication.

**Authentication:** Required (JWT Bearer token)

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | integer | Competition ID |

**Response (201):**
```json
{
  "message": "Successfully joined competition",
  "participant": {
    "id": 1,
    "competition_id": 1,
    "user_id": 1,
    "joined_at": "2025-01-01T00:00:00.000Z",
    "entry_fee_paid": "100"
  }
}
```

### DELETE /competitions/:id/leave

Leave a competition. Requires authentication.

**Authentication:** Required (JWT Bearer token)

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | integer | Competition ID |

**Response (200):**
```json
{
  "message": "Successfully left competition",
  "refund": "100"
}
```

## Leaderboard Routes

### GET /leaderboard/history

Returns historical leaderboard rankings.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `date` | ISO8601 date | - | Filter by snapshot date |
| `user_id` | integer | - | Filter by user ID |
| `limit` | integer | 50 | Number of results (1-100) |
| `offset` | integer | 0 | Number of results to skip |

**Response:**
```json
{
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "score": "1000",
      "rank": 1,
      "snapshot_date": "2025-01-01",
      "wallet_address": "0x123..."
    }
  ],
  "pagination": {
    "total": 1,
    "limit": 50,
    "offset": 0,
    "hasMore": false
  }
}
```

## Setup

```bash
# Install dependencies
npm install

# Run database migrations
npm run migrate

# Start development server
npm run dev

# Run tests
npm test

# Build for production
npm run build
```

## Database migrations

Schema changes are tracked as numbered SQL files under `backend/migrations/` using [node-pg-migrate](https://github.com/salsita/node-pg-migrate). Applied migrations are recorded in PostgreSQL (`pgmigrations_nebgov_backend`). On production and local non-test startup, migrations run automatically before the HTTP server listens.

**Apply pending migrations (CI and local)**

```bash
npm run migrate
```

Requires `DATABASE_URL`.

**Rollback**

`node-pg-migrate` applies **down** migrations one or more files at a time from the newest applied migration.

```bash
# Roll back the latest migration only
npm run migrate:down

# Roll back the latest N migrations (replace N with a positive integer)
npx tsx src/db/migrate.ts down N
```

Example: after three migrations have been applied, running `npm run migrate:down` executes the `-- Down Migration` section of `003_add_refresh_tokens.sql`. Running it again rolls back `002_add_notification_prefs.sql`, and so on.

To roll forward again after a down migration:

```bash
npm run migrate
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for JWT token signing |
| `PORT` | Server port (default: 3001) |