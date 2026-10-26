# AGENTS.md

Guidance for AI coding agents (and humans) working on this repository.

## What this is

`cf-history` is a CLI that pulls last-modified / last-modified-by metadata for
as many objects in a Cloudflare account as expose it. It runs an inventory pass
over ~35 Cloudflare API endpoints, then an Audit Logs v2 pass that supplies the
"who changed it" data almost no object API returns, and writes JSON + CSV
reports.

## Commands

```sh
pnpm install        # install dev dependencies
pnpm typecheck      # tsc --noEmit — must pass before any commit
pnpm test:e2e       # offline end-to-end test (mock API server, no credentials)
pnpm start -- ...   # run the CLI (see README for flags)
```

Both `pnpm typecheck` and `pnpm test:e2e` must pass before committing. The e2e
test requires no network access or credentials — it spins up a local mock
Cloudflare API and runs the CLI against it.

## Architecture

- `src/client.ts` — thin `fetch` client. Handles page-based pagination
  (`page`/`per_page` + `result_info.total_pages`), cursor-based pagination
  (Audit Logs v2), 429/5xx retry with backoff, and error classification
  (`auth`/`forbidden`/`not_found`/`rate_limited`/…). No runtime dependencies.
- `src/catalog.ts` — the endpoint catalog. Most endpoints are one entry in
  `buildCollectors()` (`accountSpecs` or `zoneSpecs`); multi-endpoint families
  (WAF rulesets, Pages deployments, cron triggers, R2) are separate collectors.
- `src/audit.ts` — Audit Logs v2 collector; builds a
  `resource_id → {actor, time, action}` index. Handles both the v2 nested
  shape and the legacy flat shape. Excludes `view` actions and failed actions.
- `src/join.ts` — merges inventory rows with the audit index.
- `src/util.ts` — generic timestamp/name/actor extraction. Timestamps are
  extracted by scanning known field names, **not** hardcoded per product.
- `src/doctor.ts` — token/permission probes.
- `src/report.ts` — JSON + CSV writers. The CSV column set is the `Row` type.

## Conventions

- TypeScript, strict mode, ESM (`"type": "module"`, NodeNext imports with
  `.js` extensions). Node ≥ 20.
- Zero runtime dependencies. Dev dependencies only (`typescript`, `tsx`,
  `@types/node`). Do not add runtime deps without a strong reason.
- Every collector must fail gracefully: a 403 means "missing token scope" and
  is reported in the coverage output, never fatal. Unknown/4xx responses
  should degrade to a coverage note, not a crash.
- When adding an endpoint, prefer a one-line entry in `buildCollectors()`.
  If the object has no timestamp fields, it still belongs in the catalog if
  audit logs can attribute changes to it (e.g. KV namespaces).

## Testing

- Add mock endpoints to `test/e2e.mjs` for any new behavior (new pagination
  style, new audit shape, new field extraction) and assert the resulting rows.
- Do not write tests that require real credentials or network access.

## Secrets policy

- Never commit API tokens, keys, or account credentials. Secrets come from
  environment variables (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`). `.env` is gitignored;
  `.env.example` documents the variables.
- Never print tokens in logs or test output; refer to them by masked tail.
- Generated reports (`cf-history-*.json`, `cf-history-*.csv`) contain account
  data and are gitignored — keep it that way. Do not commit report files,
  screenshots of real accounts, or real domain names in tests (use
  `example.test` / RFC 5737 addresses like the e2e mock does).
