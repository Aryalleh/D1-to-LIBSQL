# D1 → libSQL

A Cloudflare Worker that serves a [D1](https://developers.cloudflare.com/d1/) database over the
[libSQL remote protocol](https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md)
(Hrana over HTTP, JSON). Anything that talks to Turso/sqld over HTTP — `@libsql/client`,
Drizzle's `libsql` driver, Prisma's libSQL adapter, the libSQL SDKs in other languages — can use a
D1 database through it.

```ts
import { createClient } from "@libsql/client";

const db = createClient({
  url: "https://d1-to-libsql.<your-subdomain>.workers.dev", // or libsql://…
  authToken: process.env.D1_LIBSQL_TOKEN,
});

await db.execute({ sql: "SELECT * FROM users WHERE id = :id", args: { id: 1 } });
await db.batch(["INSERT INTO users (name) VALUES ('a')", "UPDATE stats SET n = n + 1"], "write");
```

## Deploy

```sh
npm install
npx wrangler d1 list                 # find your database
# edit wrangler.jsonc: set database_name / database_id of the DB binding
npx wrangler secret put AUTH_TOKEN   # the token clients pass as authToken
npm run deploy
```

Without `AUTH_TOKEN` every request is refused. For local development you can put
`ALLOW_ANONYMOUS=true` (or `AUTH_TOKEN=…`) in `.dev.vars` and run `npm run dev`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v2`, `/v3` | Version probe |
| `POST` | `/v2/pipeline`, `/v3/pipeline` | Hrana pipeline: `execute`, `batch`, `sequence`, `describe`, `store_sql`, `close_sql`, `get_autocommit`, `close` |
| `POST` | `/v3/cursor` | Hrana cursor (batch results streamed as NDJSON) |
| `POST` | `/` | Legacy libSQL HTTP API v1 (`{"statements": [...]}`, run in one transaction) |
| `GET` | `/health` | Health check (no auth) |

`/v3-protobuf` is deliberately absent; clients fall back to the JSON encoding.

## How it maps onto D1

- **Parameters**: D1 only understands positional `?`/`?NNN`, so `:name`, `@name` and `$name`
  placeholders are rewritten to `?NNN` with SQLite's own numbering rules (placeholders inside
  strings, quoted identifiers and comments are left alone).
- **Batches / transactions**: statements between `BEGIN` and `COMMIT` in one batch (which is what
  `client.batch()` sends) are run with `D1Database.batch()`, which D1 executes atomically. If any of
  them fails, the whole transaction is rolled back and the client gets a batch error.
- **Streams**: Workers are stateless, so stream state (SQL texts stored with `store_sql`) is
  carried inside the baton returned to the client.
- **Reads** use `raw({ columnNames: true })`, so column order and duplicate column names are kept.
  **Writes** use `run()` to get `rowsAffected` and `lastInsertRowid`.

## Limitations

- **No interactive transactions** (`client.transaction()`): D1 cannot keep a transaction open
  across requests. Use `client.batch()`; a `BEGIN` without a matching `COMMIT` in the same batch is
  rejected with `TRANSACTION_UNSUPPORTED`. `ROLLBACK` inside a batch is not supported either.
- When a transactional batch fails, D1 does not report which statement failed, so the error is
  attributed to the first statement of the transaction.
- D1 returns numbers as JS doubles: integers beyond ±2^53 lose precision on the way out, and whole
  `REAL` values come back as integers. Integer arguments beyond 2^53 are bound as text, which
  columns with `INTEGER` affinity convert back exactly.
- `decltype` is always `null`; `describe` reports parameters and read-only status, but no columns.
- Statements that return rows inside a transactional batch (and `RETURNING` clauses) go through
  D1's object-shaped results, so duplicate column names collapse there.
- `rows_read`/`rows_written` are not available for read statements outside a batch.
- D1's own restrictions apply (e.g. `PRAGMA foreign_keys=off` is ignored; use `PRAGMA defer_foreign_keys`).

## Development

```sh
npm test          # unit tests + end-to-end tests with @libsql/client against a local D1
npm run typecheck
```
