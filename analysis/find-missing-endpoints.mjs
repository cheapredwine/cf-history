#!/usr/bin/env node
// Analysis script: compare API endpoints with modification metadata against catalog.ts

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(__dirname, '../src/catalog.ts');
const catalogContent = readFileSync(catalogPath, 'utf-8');

// Products found in the OpenAPI spec with modification metadata
const apiProducts = {
  access: 42,
  magic: 39,
  dlp: 34,
  realtime: 22,
  settings: 21,
  cws: 20,
  gateway: 19,
  'cloudforce-one': 17,
  rulesets: 16,
  'email-security': 15,
  workers: 11,
  load_balancers: 10,
  'data-security': 9,
  devices: 8,
  api_gateway: 8,
  cache: 8,
  custom_pages: 8,
  intel: 7,
  Workflows: 7,
  'ai-search': 6,
  firewall: 6,
  waiting_rooms: 6,
  builds: 5,
  containers: 5,
  flagship: 5,
  Artifacts: 4,
  pages: 4,
  registrar: 4,
  smart_shield: 4,
  token_validation: 4,
};

// Extract what's already in the catalog
const catalogEndpoints = new Set();
const pathTemplateRegex = /pathTemplate:\s*["']([^"']+)["']/g;
let match;
while ((match = pathTemplateRegex.exec(catalogContent)) !== null) {
  catalogEndpoints.add(match[1]);
}

// Special collectors already handled
const specialCollectors = [
  'WAF rulesets & rules (zone/account)',
  'Pages deployments',
  'Workers cron triggers',
  'R2 buckets',
  'Account',
];

// Products currently covered in catalog.ts
const coveredProducts = new Set([
  'Workers',
  'Queues',
  'Hyperdrive',
  'D1',
  'Storage', // KV, R2
  'Zero Trust', // Access, Tunnels
  'Load Balancing',
  'Registrar',
  'Stream',
  'Turnstile',
  'Vectorize',
  'Account',
  'DNS',
  'Firewall',
  'Rules', // page rules
  'SaaS', // custom hostnames
  'SSL',
  'WAF', // rulesets
  'Pages',
]);

console.log('# Missing Cloudflare API Products with Modification Metadata\n');
console.log('Products from OpenAPI spec that have GET endpoints with modification fields:');
console.log('(modified_on, updated_at, created_by, modified_by, etc.)\n');

console.log('## High-Value Missing Products\n');

const highValue = [
  { name: 'access', count: 42, priority: 'HIGH', note: 'Only 5 endpoints covered (apps, tokens, IdPs, bookmarks). Missing: MCP portals/servers, policies, groups, certificates, custom pages' },
  { name: 'dlp', count: 34, priority: 'HIGH', note: 'Zero Trust DLP profiles, data classes, custom prompts — all missing' },
  { name: 'magic', count: 39, priority: 'MEDIUM', note: 'Magic Transit/WAN: DNS protection, TCP protection, prefixes, static routes, tunnels' },
  { name: 'gateway', count: 19, priority: 'HIGH', note: 'Zero Trust Gateway: app review status, certificates, configuration, lists, locations' },
  { name: 'cws', count: 20, priority: 'LOW', note: 'Cloudflare for Web (CWS): deployments, domain ACLs, basic-auth credentials' },
  { name: 'devices', count: 8, priority: 'MEDIUM', note: 'Zero Trust device management: deployment groups, IP profiles, physical devices' },
  { name: 'email-security', count: 15, priority: 'MEDIUM', note: 'Email Security: PhishGuard reports, allow policies, block senders' },
  { name: 'cloudforce-one', count: 17, priority: 'LOW', note: 'Cloudforce One rules and event queries' },
  { name: 'data-security', count: 9, priority: 'LOW', note: 'Data security posture: findings, finding types, policies' },
  { name: 'realtime', count: 22, priority: 'LOW', note: 'Realtime Kit: livestreams, meetings' },
  { name: 'api_gateway', count: 8, priority: 'MEDIUM', note: 'API Gateway: discovered operations, labels — currently only rulesets covered' },
  { name: 'Workflows', count: 7, priority: 'MEDIUM', note: 'Workers Workflows' },
  { name: 'builds', count: 5, priority: 'MEDIUM', note: 'Workers Builds: git author info' },
  { name: 'containers', count: 5, priority: 'LOW', note: 'Workers Containers' },
  { name: 'flagship', count: 5, priority: 'LOW', note: 'Feature flags (Flagship)' },
  { name: 'waiting_rooms', count: 6, priority: 'MEDIUM', note: 'Waiting rooms' },
  { name: 'cache', count: 8, priority: 'LOW', note: 'Cache settings/rules (may overlap with rulesets)' },
  { name: 'custom_pages', count: 8, priority: 'LOW', note: 'Custom error pages' },
  { name: 'settings', count: 21, priority: 'LOW', note: 'Zone/account settings — mostly low-churn config' },
];

highValue.forEach(({ name, count, priority, note }) => {
  console.log(`### ${name} (${count} endpoints)`);
  console.log(`**Priority:** ${priority}`);
  console.log(`**Note:** ${note}\n`);
});

console.log('\n## Detailed Missing Endpoint Samples\n');

// Sample endpoints by product
const sampleEndpoints = {
  access: [
    'GET /accounts/{id}/access/ai-controls/mcp/portals',
    'GET /accounts/{id}/access/ai-controls/mcp/servers',
    'GET /accounts/{id}/access/groups',
    'GET /accounts/{id}/access/certificates',
    'GET /accounts/{id}/access/policies',
  ],
  dlp: [
    'GET /accounts/{id}/dlp/custom_prompt_topics',
    'GET /accounts/{id}/dlp/data_classes',
    'GET /accounts/{id}/dlp/data_tag_categories',
    'GET /accounts/{id}/dlp/patterns',
    'GET /accounts/{id}/dlp/profiles',
  ],
  gateway: [
    'GET /accounts/{id}/gateway/apps/review_status',
    'GET /accounts/{id}/gateway/certificates',
    'GET /accounts/{id}/gateway/configuration',
    'GET /accounts/{id}/gateway/lists',
    'GET /accounts/{id}/gateway/locations',
  ],
  magic: [
    'GET /accounts/{id}/magic/advanced_dns_protection/configs/dns_protection/rules',
    'GET /accounts/{id}/magic/advanced_tcp_protection/configs/prefixes',
    'GET /accounts/{id}/magic/gre_tunnels',
    'GET /accounts/{id}/magic/ipsec_tunnels',
    'GET /accounts/{id}/magic/routes',
  ],
  devices: [
    'GET /accounts/{id}/devices/deployment-groups',
    'GET /accounts/{id}/devices/ip-profiles',
    'GET /accounts/{id}/devices/physical-devices',
    'GET /accounts/{id}/devices/posture',
  ],
  workers: [
    'GET /accounts/{id}/workers/dispatch/namespaces (modified_by, created_by)',
    'GET /accounts/{id}/workers/dispatch/namespaces/{ns}/scripts',
  ],
  builds: [
    'GET /accounts/{id}/workers/builds (git author info for CI/CD deployments)',
  ],
  Workflows: [
    'GET /accounts/{id}/workflows',
  ],
  api_gateway: [
    'GET /zones/{id}/api_gateway/discovery/operations',
    'GET /zones/{id}/api_gateway/labels',
  ],
  waiting_rooms: [
    'GET /zones/{id}/waiting_rooms',
    'GET /zones/{id}/waiting_rooms/{id}/events',
  ],
};

Object.entries(sampleEndpoints).forEach(([product, endpoints]) => {
  console.log(`### ${product}`);
  endpoints.forEach(ep => console.log(`- ${ep}`));
  console.log('');
});

console.log('\n## Already Covered in Catalog\n');
console.log('Current catalog.ts coverage:');
coveredProducts.forEach(p => console.log(`- ${p}`));

console.log('\n## Recommendations\n');

console.log(`
1. **Immediate additions (HIGH priority):**
   - Access: MCP portals/servers, groups, policies (modified_by + created_by)
   - DLP: profiles, data classes, patterns (updated_at)
   - Gateway: lists, locations, certificates (updated_at)
   - API Gateway: discovery operations, labels (last_updated)

2. **Medium priority (Zero Trust / Workers ecosystem):**
   - Devices: deployment groups, IP profiles, posture rules
   - Magic Transit/WAN: protection rules, tunnels, static routes
   - Workers: dispatch namespaces (modified_by), Workflows
   - Workers Builds: git author attribution for CI/CD scripts
   - Waiting rooms: rooms + events

3. **Lower priority (specialized/niche):**
   - Email Security: PhishGuard, allow/block policies
   - Cloudforce One: rules, event queries
   - Realtime Kit, CWS, Flagship, Containers

4. **Endpoint patterns:**
   - Most use \`updated_at\` (not \`modified_on\`)
   - Access/Workers have \`modified_by\`, \`created_by\` — rare
   - API Gateway uses \`last_updated\`
   - Load balancers use both \`modified_on\` and \`updated_at\`

5. **Implementation notes:**
   - All fit the one-line \`listCollector\` pattern in catalog.ts
   - No special multi-endpoint collectors needed
   - Extract permissions from OpenAPI \`x-api-token-group\`
   - Test with \`--doctor\` to verify token scopes
`);

console.log('\n## Next Steps\n');
console.log(`
1. Add HIGH priority endpoints to catalog.ts accountSpecs/zoneSpecs
2. Update test/e2e.mjs with mock endpoints for new products
3. Run \`pnpm typecheck && pnpm test:e2e\` to verify
4. Update README permission checklist per product
5. Run against live account with \`--doctor\` to confirm coverage
`);
