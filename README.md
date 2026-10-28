# cf-history

> ⚠️ **NOT OFFICIAL CLOUDFLARE.** Not affiliated with or endorsed by Cloudflare, Inc.
> NO WARRANTIES, EXPRESS OR IMPLIED. Effectively untested demo code — read everything
> and dry-run before you run. You assume all risk. See [DISCLAIMER.md](./DISCLAIMER.md).


Pulls **last-modified / last-modified-by** metadata for as many objects in a
Cloudflare account as expose it, and writes a JSON + CSV report.

Almost no Cloudflare object API returns *who* made the last change, so this
tool works in two passes:

1. **Inventory pass** — walks **53 collectors** across the Cloudflare API
   (zones, DNS, WAF, Workers, storage, Pages, Zero Trust Access/Gateway/DLP/Devices,
   API Gateway, Waiting Rooms, SSL, registrar, …) collecting every object that
   exposes a timestamp (`modified_on`, `last_updated`, `updated_at`, `creation_date`, …).
   Field names differ per product, so timestamps are extracted generically.
2. **Audit pass** — fetches [Audit Logs v2](https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/)
   (`GET /accounts/{id}/logs/audit`, ~18 months retention, ~95% product
   coverage) and builds a `resource_id → {actor, time, action}` index.
3. **Join** — each row's `modified_by` comes from the object API where it
   exists (e.g. DNS records), otherwise from the audit index. The
   `modified_by_source` column tells you which: `api` | `audit` | `none`.
   Objects with neither timestamps nor audit activity are dropped (and counted).

## Usage

```sh
export CLOUDFLARE_API_TOKEN=...       # read-scoped token, see below
export CLOUDFLARE_ACCOUNT_ID=...      # optional if --account is passed

pnpm start                            # full report → ./cf-history-*.json + .csv
pnpm start -- --doctor                # token check: which permissions are missing
pnpm start -- --coverage              # per-endpoint collection report
pnpm start -- --since 30d             # only recently modified/created objects
pnpm start -- --type dns              # filter by domain/object-type substring
pnpm start -- --out ./reports         # output directory
```

If no account is specified, the tool auto-detects when the token can see
exactly one account. Progress and warnings go to stderr; reports go to stdout
summary + files.

## Token setup

Create an API token (My Profile → API Tokens → Create Token → Custom) with
**read** permissions. Required for the core:

| Permission | Why |
|---|---|
| Account Settings **Read** | account object, Audit Logs v2 (the "who" backbone) |
| Zone **Read** | enumerate zones |

Then add what you want covered — everything is optional and detected per-run:

| Permission | Covers |
|---|---|
| DNS **Read** | DNS records (incl. `created_by`/`modified_by` where exposed) |
| Zone WAF **Read** / Account WAF **Read** / Account Rulesets **Read** | WAF rulesets + rules (`last_updated` at ruleset *and* rule level) |
| Zone Firewall Services / Firewall Access Rules **Read** | legacy firewall rules, IP access rules |
| Workers Scripts **Read** | Workers scripts, domains, dispatch namespaces, Workflows, DO namespaces, cron triggers |
| Workers KV Storage **Read** | KV namespaces (no timestamps — audit fills in) |
| Workers R2 Storage **Read** | R2 buckets via the Cloudflare API |
| D1 **Read** | D1 databases |
| Queues **Read** | Queues |
| Hyperdrive **Read** | Hyperdrive configs |
| Vectorize **Read** | Vectorize indexes |
| Cloudflare Pages **Read** | Pages projects + deployments (commit author via `deployment_trigger`) |
| Access: Apps and Policies **Read** | Access apps, groups, policies, bookmarks, MCP portals/servers |
| Access: Service Tokens **Read** | Access service tokens |
| Access: Identity Providers **Read** | Access identity providers |
| Access: Organizations **Read** | Access certificates |
| Zero Trust **Read** | Gateway lists/locations/certificates/rules, DLP profiles/patterns/datasets, Device posture rules |
| Cloudflare Tunnel **Read** | tunnels (+ last connection time) |
| API Gateway **Read** | API operations, discovered operations |
| Zone Waiting Room **Read** | Waiting rooms |
| Load Balancing **Read** | pools, monitors, zone load balancers |
| SSL and Certificates **Read** | certificate packs, custom certificates |
| Cloudflare for SaaS **Read** | custom hostnames |
| Domain Registration **Read** | registrar domains |
| Stream **Read** | Stream videos |
| Turnstile **Read** | widgets |
| Account API Tokens **Read** | account-owned API tokens (+ last used) |

Zone-scoped permissions can be limited to the account's zones.

### R2 fallback

If the Cloudflare API path for R2 buckets is not permitted, the tool falls back
to the S3-compatible `ListBuckets` when you provide an R2 access key pair:

```sh
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
```

(Created under R2 → Manage R2 API Tokens.)

## Output

**CSV columns** (`cf-history-<account>-<timestamp>.csv`):

```
object_type, domain, scope, account_name, zone_name, object_id, object_name,
created_at, created_by, modified_at, modified_by, modified_by_source, notes
```

**JSON** additionally contains: generation metadata, audit window + entry
count, per-domain totals, the full coverage report (which endpoints were
collected / forbidden / not available), and all rows.

### Honesty rules

- `modified_by_source: audit` — filled from audit logs; the `notes` column
  records the action type, description, and interface (`dashboard`, `api`, …).
- Actors that audit logs cannot attribute (system, delegated services, account
  tokens) are surfaced as such rather than silently blank.
- Changes older than the ~18-month audit retention show `modified_by_source:
  none` — a real gap, not a bug.
- `view` actions and failed actions are excluded from attribution.
- Objects with no timestamps anywhere (e.g. KV namespaces untouched in the
  audit window) are excluded, and the exclusion is counted.

## Development

```sh
pnpm install
pnpm typecheck        # tsc --noEmit
pnpm test:e2e         # offline: spins up a mock API, runs the CLI, asserts the output
```

The e2e test needs no credentials — it runs against a local mock server
(`CFH_API_BASE` overrides the API base URL).

### Adding an endpoint

Most endpoints are one line in `buildCollectors()` in `src/catalog.ts`
(`accountSpecs` / `zoneSpecs`). Timestamps and names are extracted generically;
you only specify the path, object type, and permission hint. Multi-endpoint
families (rulesets, Pages deployments, cron, R2) are separate collectors.

## License

[MIT](./LICENSE) — see [TODO.md](./TODO.md) for planned work and
[AGENTS.md](./AGENTS.md) for contributor/agent guidance.
