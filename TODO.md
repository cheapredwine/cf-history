# TODO

## Coverage

- [ ] Organization-level audit logs (`GET /organizations/{id}/logs/audit`) for
      users with Organization Super Administrator access
- [ ] Workers Builds: git author + commit for Workers deployed via CI/CD
      (`/accounts/{id}/builds/...`)
- [ ] Access policies per application (`/access/apps/{id}/policies`) and
      reusable policies (`/access/policies`)
- [ ] Gateway / DLP / device posture endpoints (Zero Trust `Zero Trust Read`
      scope is already common)
- [ ] Cloudflare Images and Stream thumbnails (Image v2 API shape)
- [ ] Cache Rules, Snippets, Origin Rules, Compression Rules — covered by
      rulesets today; consider per-rule-type labels
- [ ] Bot management / super bot fight mode config
- [ ] Address maps, BYOIP prefixes (Magic Transit accounts)
- [ ] Durable Objects namespaces: per-namespace object counts
- [ ] Workers for Platforms dispatch namespaces
- [ ] Hyperdrive: retest now that doctor reports it as a separate permission

## Attribution quality

- [ ] Use `actor.token_name` in the audit index when email is absent
      (currently falls back to actor id)
- [ ] Correlate audit `resource.product` into row notes
- [ ] Optional `--deep` mode: per-resource audit history
      (`/logs/audit/{id}/history`) for change trails with diffs
- [ ] Confidence note when audit action time and API `modified_on` disagree
      by more than a threshold

## Tooling

- [ ] GitHub Actions release workflow (npm publish, optional)
- [ ] `--format markdown` report for pasting into tickets
- [ ] Global token-bucket rate limiter across concurrent collectors
      (currently per-request 429 retry only)
- [ ] Config file support (`.cf-history.json`) for default flags
- [ ] Multi-account runs (`--all-accounts` using Memberships)
- [ ] Delta mode: store previous JSON and emit only what changed since
- [ ] Smoke test against a real account in CI via repository secret
      (read-only token, least privilege)

## Docs

- [ ] Screenshot/example of the summary output
- [ ] Per-product coverage matrix generated from a live run
      (`--coverage --format json` → README table)
