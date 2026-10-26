# Changelog

All notable changes to cf-history will be documented in this file.

## [Unreleased]

### Added (2026-10-26)
- **19 new endpoints** from systematic OpenAPI spec audit:
  - **Workers ecosystem**: dispatch namespaces (modified_by/created_by), Workflows
  - **Zero Trust Access** (8 new): groups, policies, certificates, MCP portals/servers
  - **Zero Trust Gateway** (4 new): lists, locations, certificates, rules
  - **Zero Trust DLP** (3 new): profiles, patterns, datasets
  - **Zero Trust Devices**: posture rules
  - **API Gateway** (2 new): operations, discovered operations
  - **Waiting Rooms**: zone waiting rooms
- Analysis script `analysis/find-missing-endpoints.mjs` that compares OpenAPI spec against catalog
- Total coverage increased from ~35 to **54 collectors**

### Changed
- Reorganized `accountSpecs` in catalog.ts by product area for clarity
- Added inline comments grouping related services (Workers, Storage, Zero Trust, etc.)
- Reorganized `zoneSpecs` with product-area grouping

### Notes
- 491 total GET endpoints in Cloudflare API have modification metadata
- HIGH priority additions completed: Access (MCP, groups, policies), DLP, Gateway, API Gateway
- MEDIUM priority remaining: Magic Transit/WAN, Email Security, Workers Builds (git author)
- Refer to `analysis/find-missing-endpoints.mjs` output for remaining endpoint gaps

## [1.0.0] - 2026-10-23

### Added
- Initial release
- Two-pass architecture: inventory → audit logs → join
- ~35 collectors covering Workers, Pages, R2, D1, KV, Queues, Hyperdrive, Vectorize
- Access apps/tokens/IdPs/bookmarks, Tunnels, DNS, WAF, firewall, SSL, registrar, Stream, Turnstile
- JSON + CSV output formats
- `--doctor` mode for token permission verification
- `--coverage` summary report
- Offline e2e test with mock API server
- MIT license
- CI workflow (typecheck + e2e on Node 20/22)
