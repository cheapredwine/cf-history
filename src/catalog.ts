// Declarative catalog of everything in a Cloudflare account that exposes
// last-modified/last-modified-by metadata. Each collector is one endpoint
// (or a small family of endpoints); failures are classified, not fatal.

import { CFApiClient, CFApiError } from "./client.js";
import type { Collector, CollectorOutcome, Row, RunCtx, ZoneInfo } from "./types.js";
import { extractTimestamps, pickBys, pickName, appendNote, trunc } from "./util.js";
import { r2ListBuckets } from "./r2.js";

export interface CollectOneResult {
  rows: Row[];
  outcome: CollectorOutcome;
  message: string | null;
}

export function classify(err: unknown): { outcome: CollectorOutcome; message: string } {
  if (err instanceof CFApiError) {
    switch (err.kind) {
      case "forbidden":
        return { outcome: "forbidden", message: "missing token permission" };
      case "auth":
        return { outcome: "error", message: "authentication failed (401)" };
      case "not_found":
        return { outcome: "not_found", message: "not available on this account/plan" };
      case "rate_limited":
        return { outcome: "error", message: "rate limited" };
      case "bad_request":
        return { outcome: "skipped", message: `bad request: ${err.message}` };
      default:
        return { outcome: "error", message: err.message };
    }
  }
  return { outcome: "error", message: (err as Error)?.message ?? String(err) };
}

export function makeRow(opts: {
  ctx: RunCtx;
  zoneName: string | null;
  objectType: string;
  domain: string;
  scope: "account" | "zone";
  id: string;
  name?: string | null;
  obj?: unknown;
  notes?: string | null;
}): Row {
  const obj = (opts.obj ?? {}) as Record<string, unknown>;
  const { modified, created } = extractTimestamps(obj);
  const bys = pickBys(obj);
  let modifiedBy = bys.modifiedBy;
  let source: Row["modified_by_source"] = modifiedBy ? "api" : "none";
  // If the record was never modified, the creator was the last modifier.
  if (!modifiedBy && bys.createdBy && modified && created && modified === created) {
    modifiedBy = bys.createdBy;
  }
  return {
    object_type: opts.objectType,
    domain: opts.domain,
    scope: opts.scope,
    account_name: opts.ctx.accountName,
    zone_name: opts.zoneName,
    object_id: opts.id,
    object_name: opts.name && opts.name.trim() !== "" ? opts.name : opts.id,
    created_at: created,
    created_by: bys.createdBy,
    modified_at: modified,
    modified_by: modifiedBy,
    modified_by_source: source,
    notes: opts.notes ?? null,
  };
}

interface ListSpec {
  id: string;
  label: string;
  domain: string;
  objectType: string;
  scope: "account" | "zone";
  permissionHint: string;
  path: (accountId: string, zone?: ZoneInfo) => string;
  params?: Record<string, unknown>;
  unwrap?: (result: unknown) => unknown[];
  idKey?: string;
  notes?: (obj: any) => string | null;
  maxPages?: number;
}

function listCollector(spec: ListSpec): Collector {
  return {
    id: spec.id,
    label: spec.label,
    domain: spec.domain,
    scope: spec.scope,
    permissionHint: spec.permissionHint,
    async runOne(ctx, zone) {
      try {
        const path = spec.path(ctx.accountId, zone);
        const items = await ctx.client.listAll(path, spec.params ?? {}, {
          maxPages: spec.maxPages,
          unwrap: spec.unwrap,
        });
        const rows: Row[] = [];
        for (const obj of items) {
          const o = obj as Record<string, any>;
          const id = String(o?.[spec.idKey ?? "id"] ?? "").trim();
          if (id === "") continue;
          rows.push(
            makeRow({
              ctx,
              zoneName: zone?.name ?? null,
              objectType: spec.objectType,
              domain: spec.domain,
              scope: spec.scope,
              id,
              name: pickName(o, id),
              obj: o,
              notes: spec.notes ? spec.notes(o) : null,
            }),
          );
        }
        return { rows, outcome: "collected", message: items.length === 0 ? "no objects found" : null };
      } catch (err) {
        const c = classify(err);
        return { rows: [], outcome: c.outcome, message: c.message };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Special collectors (multi-endpoint families)
// ---------------------------------------------------------------------------

async function collectRulesets(
  ctx: RunCtx,
  basePath: string,
  zoneName: string | null,
  scope: "account" | "zone",
  detailCap: number,
): Promise<CollectOneResult> {
  try {
    const rulesets = (await ctx.client.listAll(basePath)) as any[];
    const rows: Row[] = [];
    let fetched = 0;
    for (const rs of rulesets) {
      const phase = rs?.phase ?? "unknown";
      rows.push(
        makeRow({
          ctx, zoneName,
          objectType: `WAF ruleset (${phase})`,
          domain: "WAF", scope,
          id: String(rs?.id ?? ""),
          name: rs?.name ?? null,
          obj: rs,
          notes: `kind=${rs?.kind ?? "?"} version=${rs?.version ?? "?"}`,
        }),
      );
      if (fetched < detailCap) {
        fetched++;
        try {
          const detail = await ctx.client.get(`${basePath}/${rs.id}`);
          for (const rule of ((detail.result as any)?.rules ?? []) as any[]) {
            rows.push(
              makeRow({
                ctx, zoneName,
                objectType: `WAF rule (${phase})`,
                domain: "WAF", scope,
                id: String(rule?.id ?? ""),
                name: rule?.description || rule?.ref || null,
                obj: rule,
                notes: `ruleset=${rs.name} expression=${trunc(rule?.expression, 120)}`,
              }),
            );
          }
        } catch {
          // per-ruleset detail failures are non-fatal
        }
      }
    }
    return {
      rows: rows.filter((r) => r.object_id !== ""),
      outcome: "collected",
      message: rulesets.length === 0 ? "no rulesets found" : null,
    };
  } catch (err) {
    const c = classify(err);
    return { rows: [], outcome: c.outcome, message: c.message };
  }
}

const wafZoneRulesetsCollector: Collector = {
  id: "waf_zone_rulesets",
  label: "WAF rulesets & rules (zone)",
  domain: "WAF",
  scope: "zone",
  permissionHint: "Zone WAF read / zone rulesets read",
  async runOne(ctx, zone) {
    return collectRulesets(ctx, `/zones/${zone!.id}/rulesets`, zone!.name, "zone", 25);
  },
};

const wafAccountRulesetsCollector: Collector = {
  id: "waf_account_rulesets",
  label: "WAF rulesets & rules (account)",
  domain: "WAF",
  scope: "account",
  permissionHint: "Account WAF read / account rulesets read",
  async runOne(ctx) {
    return collectRulesets(ctx, `/accounts/${ctx.accountId}/rulesets`, null, "account", 10);
  },
};

const pagesDeploymentsCollector: Collector = {
  id: "pages_deployments",
  label: "Pages projects & deployments",
  domain: "Pages",
  scope: "account",
  permissionHint: "Cloudflare Pages read",
  async runOne(ctx) {
    try {
      const projects = (await ctx.client.listAll(
        `/accounts/${ctx.accountId}/pages/projects`, {}, { maxPages: 10 },
      )) as any[];
      const rows: Row[] = [];
      for (const p of projects.slice(0, 100)) {
        const projectName = typeof p?.name === "string" ? p.name : "";
        rows.push(
          makeRow({
            ctx, zoneName: null,
            objectType: "Pages project", domain: "Pages", scope: "account",
            id: String(p?.id ?? projectName),
            name: projectName || null,
            obj: p,
            notes: Array.isArray(p?.domains) && p.domains.length > 0 ? `domains: ${p.domains.join(", ")}` : null,
          }),
        );
        if (projectName === "") continue;
        try {
          const deployments = (await ctx.client.listAll(
            `/accounts/${ctx.accountId}/pages/projects/${encodeURIComponent(projectName)}/deployments`,
            {}, { maxPages: 5 },
          )) as any[];
          for (const d of deployments) {
            const meta = d?.deployment_trigger?.metadata ?? {};
            rows.push(
              makeRow({
                ctx, zoneName: null,
                objectType: "Pages deployment", domain: "Pages", scope: "account",
                id: String(d?.id ?? ""),
                name: `${projectName}: ${trunc(meta?.commit_message ?? d?.id, 80)}`,
                obj: d,
                notes: `branch=${meta?.branch ?? "?"} commit=${String(meta?.commit_hash ?? "?").slice(0, 10)} author=${meta?.author_name ?? meta?.author_email ?? "?"}`,
              }),
            );
          }
        } catch {
          // per-project failures non-fatal
        }
      }
      return {
        rows: rows.filter((r) => r.object_id !== ""),
        outcome: "collected",
        message: projects.length === 0 ? "no projects found" : null,
      };
    } catch (err) {
      const c = classify(err);
      return { rows: [], outcome: c.outcome, message: c.message };
    }
  },
};

const workersCronCollector: Collector = {
  id: "workers_cron_triggers",
  label: "Worker cron triggers",
  domain: "Workers",
  scope: "account",
  permissionHint: "Workers scripts read",
  async runOne(ctx) {
    try {
      const scripts = (await ctx.client.listAll(`/accounts/${ctx.accountId}/workers/scripts`)) as any[];
      const rows: Row[] = [];
      for (const s of scripts.slice(0, 200)) {
        const scriptId = typeof s?.id === "string" ? s.id : "";
        if (scriptId === "") continue;
        try {
          const { result } = await ctx.client.get(
            `/accounts/${ctx.accountId}/workers/scripts/${encodeURIComponent(scriptId)}/schedules`,
          );
          const schedules = Array.isArray((result as any)?.schedules) ? (result as any).schedules : [];
          schedules.forEach((sch: any, i: number) => {
            rows.push(
              makeRow({
                ctx, zoneName: null,
                objectType: "Worker cron trigger", domain: "Workers", scope: "account",
                id: `${scriptId}#${i}`,
                name: `${scriptId}: ${sch?.cron ?? "?"}`,
                obj: sch,
                notes: `script=${scriptId} cron=${sch?.cron ?? "?"}`,
              }),
            );
          });
        } catch {
          // per-script failures non-fatal
        }
      }
      return {
        rows: rows.filter((r) => r.object_id !== ""),
        outcome: "collected",
        message: scripts.length === 0 ? "no workers found" : null,
      };
    } catch (err) {
      const c = classify(err);
      return { rows: [], outcome: c.outcome, message: c.message };
    }
  },
};

const r2BucketsCollector: Collector = {
  id: "r2_buckets",
  label: "R2 buckets",
  domain: "Storage",
  scope: "account",
  permissionHint: "Workers R2 Storage read (or R2 S3 credentials)",
  async runOne(ctx) {
    try {
      const buckets = (await ctx.client.listAll(`/accounts/${ctx.accountId}/r2/buckets`, {}, {
        unwrap: (r) => (Array.isArray(r) ? r : ((r as any)?.buckets ?? [])),
      })) as any[];
      const rows = buckets
        .map((b) =>
          makeRow({
            ctx, zoneName: null,
            objectType: "R2 bucket", domain: "Storage", scope: "account",
            id: String(b?.name ?? b?.id ?? ""),
            name: b?.name ?? null,
            obj: b,
            notes: b?.location ? `location=${b.location}` : null,
          }),
        )
        .filter((r) => r.object_id !== "");
      return { rows, outcome: "collected", message: buckets.length === 0 ? "no buckets found" : null };
    } catch (err) {
      // Fallback: S3-compatible ListBuckets with an R2 access key pair.
      const ak = process.env.R2_ACCESS_KEY_ID;
      const sk = process.env.R2_SECRET_ACCESS_KEY;
      if (ak && sk) {
        try {
          const buckets = await r2ListBuckets(ctx.accountId, ak, sk);
          const rows = buckets.map((b) =>
            makeRow({
              ctx, zoneName: null,
              objectType: "R2 bucket", domain: "Storage", scope: "account",
              id: b.name, name: b.name, obj: b,
            }),
          );
          return { rows, outcome: "collected", message: buckets.length === 0 ? "no buckets found" : null };
        } catch (e2) {
          return { rows: [], outcome: "error", message: `R2 S3 API error: ${(e2 as Error).message}` };
        }
      }
      const c = classify(err);
      if (c.outcome === "forbidden" || c.outcome === "not_found") {
        return {
          rows: [], outcome: c.outcome,
          message: `${c.message}; optionally set R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY for the S3 fallback`,
        };
      }
      return { rows: [], outcome: c.outcome, message: c.message };
    }
  },
};

const accountCollector: Collector = {
  id: "account",
  label: "Account",
  domain: "Account",
  scope: "account",
  permissionHint: "Account settings read",
  async runOne(ctx) {
    try {
      const { result } = await ctx.client.get(`/accounts/${ctx.accountId}`);
      if (!result || typeof result !== "object") {
        return { rows: [], outcome: "collected", message: "no account object returned" };
      }
      return {
        rows: [
          makeRow({
            ctx, zoneName: null,
            objectType: "Account", domain: "Account", scope: "account",
            id: ctx.accountId,
            name: (result as any)?.name ?? null,
            obj: result,
          }),
        ],
        outcome: "collected",
        message: null,
      };
    } catch (err) {
      const c = classify(err);
      return { rows: [], outcome: c.outcome, message: c.message };
    }
  },
};

function tunnelNotes(o: any): string | null {
  const conns = Array.isArray(o?.connections) ? o.connections : [];
  let lastSeen: string | null = null;
  for (const c of conns) {
    const ls = c?.last_seen;
    if (typeof ls === "string" && (lastSeen === null || ls > lastSeen)) lastSeen = ls;
  }
  return appendNote(o?.status ? `status=${o.status}` : null, lastSeen ? `last_connection=${lastSeen}` : null);
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export function buildCollectors(): Collector[] {
  const accountSpecs: Array<Omit<ListSpec, "scope" | "path"> & { pathTemplate: string }> = [
    // Workers
    { id: "workers_scripts", label: "Workers scripts", domain: "Workers", objectType: "Worker script", permissionHint: "Workers scripts read", pathTemplate: "/accounts/%A/workers/scripts" },
    { id: "workers_domains", label: "Workers custom domains", domain: "Workers", objectType: "Worker custom domain", permissionHint: "Workers scripts read", pathTemplate: "/accounts/%A/workers/domains", notes: (o) => (o?.zone_name ? `zone=${o.zone_name} service=${o.service ?? "?"}` : null) },
    { id: "workers_dispatch_namespaces", label: "Workers dispatch namespaces", domain: "Workers", objectType: "Workers dispatch namespace", permissionHint: "Workers scripts read", pathTemplate: "/accounts/%A/workers/dispatch/namespaces" },
    { id: "workers_workflows", label: "Workers Workflows", domain: "Workers", objectType: "Workflow", permissionHint: "Workers scripts read", pathTemplate: "/accounts/%A/workflows" },
    { id: "durable_objects_namespaces", label: "Durable Object namespaces", domain: "Workers", objectType: "Durable Object namespace", permissionHint: "Workers scripts read", pathTemplate: "/accounts/%A/workers/durable_objects/namespaces" },
    // Storage & Data
    { id: "queues", label: "Queues", domain: "Queues", objectType: "Queue", permissionHint: "Queues read", pathTemplate: "/accounts/%A/queues" },
    { id: "hyperdrive_configs", label: "Hyperdrive configs", domain: "Hyperdrive", objectType: "Hyperdrive config", permissionHint: "Hyperdrive read", pathTemplate: "/accounts/%A/hyperdrive/configs" },
    { id: "d1_databases", label: "D1 databases", domain: "D1", objectType: "D1 database", permissionHint: "D1 read", pathTemplate: "/accounts/%A/d1/database" },
    { id: "kv_namespaces", label: "KV namespaces", domain: "Storage", objectType: "KV namespace", permissionHint: "Workers KV Storage read", pathTemplate: "/accounts/%A/storage/kv/namespaces" },
    { id: "vectorize_indexes", label: "Vectorize indexes", domain: "Vectorize", objectType: "Vectorize index", permissionHint: "Vectorize read", pathTemplate: "/accounts/%A/vectorize/v2/indexes", unwrap: (r) => (Array.isArray(r) ? r : ((r as any)?.indexes ?? (r as any)?.result ?? [])) },
    // Zero Trust Access
    { id: "access_apps", label: "Access applications", domain: "Zero Trust", objectType: "Access application", permissionHint: "Access: apps and policies read", pathTemplate: "/accounts/%A/access/apps" },
    { id: "access_groups", label: "Access groups", domain: "Zero Trust", objectType: "Access group", permissionHint: "Access: apps and policies read", pathTemplate: "/accounts/%A/access/groups" },
    { id: "access_policies", label: "Access policies", domain: "Zero Trust", objectType: "Access policy", permissionHint: "Access: apps and policies read", pathTemplate: "/accounts/%A/access/policies" },
    { id: "access_service_tokens", label: "Access service tokens", domain: "Zero Trust", objectType: "Access service token", permissionHint: "Access: service tokens read", pathTemplate: "/accounts/%A/access/service_tokens", notes: (o) => (o?.expires_at ? `expires=${o.expires_at}` : null) },
    { id: "access_identity_providers", label: "Access identity providers", domain: "Zero Trust", objectType: "Access identity provider", permissionHint: "Access: identity providers read", pathTemplate: "/accounts/%A/access/identity_providers" },
    { id: "access_bookmarks", label: "Access bookmarks", domain: "Zero Trust", objectType: "Access bookmark", permissionHint: "Access: apps and policies read", pathTemplate: "/accounts/%A/access/bookmarks" },
    { id: "access_certificates", label: "Access certificates", domain: "Zero Trust", objectType: "Access certificate", permissionHint: "Access: organizations read", pathTemplate: "/accounts/%A/access/certificates" },
    { id: "access_mcp_portals", label: "Access MCP portals", domain: "Zero Trust", objectType: "MCP portal", permissionHint: "Access: apps and policies read", pathTemplate: "/accounts/%A/access/ai-controls/mcp/portals" },
    { id: "access_mcp_servers", label: "Access MCP servers", domain: "Zero Trust", objectType: "MCP server", permissionHint: "Access: apps and policies read", pathTemplate: "/accounts/%A/access/ai-controls/mcp/servers" },
    // Zero Trust Gateway
    { id: "gateway_lists", label: "Gateway lists", domain: "Zero Trust", objectType: "Gateway list", permissionHint: "Zero Trust read", pathTemplate: "/accounts/%A/gateway/lists" },
    { id: "gateway_locations", label: "Gateway locations", domain: "Zero Trust", objectType: "Gateway location", permissionHint: "Zero Trust read", pathTemplate: "/accounts/%A/gateway/locations" },
    { id: "gateway_certificates", label: "Gateway certificates", domain: "Zero Trust", objectType: "Gateway certificate", permissionHint: "Zero Trust read", pathTemplate: "/accounts/%A/gateway/certificates" },
    { id: "gateway_rules", label: "Gateway rules", domain: "Zero Trust", objectType: "Gateway rule", permissionHint: "Zero Trust read", pathTemplate: "/accounts/%A/gateway/rules" },
    // Zero Trust DLP
    { id: "dlp_profiles", label: "DLP profiles", domain: "Zero Trust", objectType: "DLP profile", permissionHint: "Zero Trust read", pathTemplate: "/accounts/%A/dlp/profiles" },
    { id: "dlp_patterns", label: "DLP patterns", domain: "Zero Trust", objectType: "DLP pattern", permissionHint: "Zero Trust read", pathTemplate: "/accounts/%A/dlp/patterns" },
    { id: "dlp_datasets", label: "DLP datasets", domain: "Zero Trust", objectType: "DLP dataset", permissionHint: "Zero Trust read", pathTemplate: "/accounts/%A/dlp/datasets" },
    // Zero Trust Devices
    { id: "devices_posture", label: "Device posture rules", domain: "Zero Trust", objectType: "Device posture rule", permissionHint: "Zero Trust read", pathTemplate: "/accounts/%A/devices/posture" },
    // Tunnels
    { id: "cfd_tunnels", label: "Cloudflare Tunnels", domain: "Zero Trust", objectType: "Cloudflare Tunnel", permissionHint: "Cloudflare Tunnel read", pathTemplate: "/accounts/%A/cfd_tunnel", params: { is_deleted: "false" }, notes: tunnelNotes },
    // Load Balancing
    { id: "lb_pools", label: "Load balancer pools", domain: "Load Balancing", objectType: "LB pool", permissionHint: "Load balancing read", pathTemplate: "/accounts/%A/load_balancers/pools" },
    { id: "lb_monitors", label: "Load balancer monitors", domain: "Load Balancing", objectType: "LB monitor", permissionHint: "Load balancing read", pathTemplate: "/accounts/%A/load_balancers/monitors" },
    // Other services
    { id: "registrar_domains", label: "Registrar domains", domain: "Registrar", objectType: "Registered domain", permissionHint: "Domain registration read", pathTemplate: "/accounts/%A/registrar/domains" },
    { id: "stream_videos", label: "Stream videos", domain: "Stream", objectType: "Stream video", permissionHint: "Stream read", pathTemplate: "/accounts/%A/stream", unwrap: (r) => (Array.isArray(r) ? r : ((r as any)?.videos ?? (r as any)?.result ?? [])) },
    { id: "turnstile_widgets", label: "Turnstile widgets", domain: "Turnstile", objectType: "Turnstile widget", permissionHint: "Turnstile read", pathTemplate: "/accounts/%A/challenges/widgets" },
    { id: "account_api_tokens", label: "Account API tokens", domain: "Account", objectType: "Account API token", permissionHint: "Account API tokens read", pathTemplate: "/accounts/%A/tokens", notes: (o) => appendNote(o?.status ? `status=${o.status}` : null, o?.last_used_on ? `last_used=${o.last_used_on}` : null) },
  ];

  const accountCollectors: Collector[] = accountSpecs.map((spec) =>
    listCollector({
      ...spec,
      scope: "account",
      path: (a) => spec.pathTemplate.replace("%A", a),
    }),
  );

  const zoneSpecs: Array<Omit<ListSpec, "scope" | "path"> & { pathTemplate: string }> = [
    // DNS
    { id: "dns_records", label: "DNS records", domain: "DNS", objectType: "DNS record", permissionHint: "DNS read", pathTemplate: "/zones/%Z/dns_records" },
    // Firewall (legacy)
    { id: "firewall_rules", label: "Firewall rules (legacy)", domain: "Firewall", objectType: "Firewall rule", permissionHint: "Zone firewall read", pathTemplate: "/zones/%Z/firewall/rules" },
    { id: "firewall_access_rules", label: "IP access rules (zone)", domain: "Firewall", objectType: "IP access rule", permissionHint: "Zone firewall access rules read", pathTemplate: "/zones/%Z/firewall/access_rules/rules" },
    { id: "rate_limits", label: "Rate limit rules (legacy)", domain: "Firewall", objectType: "Rate limit rule", permissionHint: "Zone rate limiting read", pathTemplate: "/zones/%Z/rate_limits" },
    // Rules
    { id: "page_rules", label: "Page rules", domain: "Rules", objectType: "Page rule", permissionHint: "Page rules read", pathTemplate: "/zones/%Z/pagerules" },
    // API Gateway
    { id: "api_gateway_operations", label: "API Gateway operations", domain: "API Gateway", objectType: "API operation", permissionHint: "API Gateway read", pathTemplate: "/zones/%Z/api_gateway/operations" },
    { id: "api_gateway_discovery", label: "API Gateway discovered operations", domain: "API Gateway", objectType: "Discovered API operation", permissionHint: "API Gateway read", pathTemplate: "/zones/%Z/api_gateway/discovery/operations" },
    // Waiting Rooms
    { id: "waiting_rooms", label: "Waiting rooms", domain: "Waiting Rooms", objectType: "Waiting room", permissionHint: "Zone waiting room read", pathTemplate: "/zones/%Z/waiting_rooms" },
    // Load Balancing
    { id: "zone_load_balancers", label: "Zone load balancers", domain: "Load Balancing", objectType: "Load balancer", permissionHint: "Load balancing read", pathTemplate: "/zones/%Z/load_balancers" },
    // Workers
    { id: "workers_routes", label: "Workers routes", domain: "Workers", objectType: "Workers route", permissionHint: "Workers routes read", pathTemplate: "/zones/%Z/workers/routes", notes: (o) => (o?.pattern ? `pattern=${o.pattern} script=${o.script ?? "?"}` : null) },
    // SaaS & SSL
    { id: "custom_hostnames", label: "Custom hostnames (SaaS)", domain: "SaaS", objectType: "Custom hostname", permissionHint: "Cloudflare for SaaS read", pathTemplate: "/zones/%Z/custom_hostnames" },
    { id: "ssl_certificate_packs", label: "SSL certificate packs", domain: "SSL", objectType: "SSL certificate pack", permissionHint: "SSL and certificates read", pathTemplate: "/zones/%Z/ssl/certificate_packs" },
    { id: "ssl_custom_certificates", label: "Custom certificates", domain: "SSL", objectType: "Custom SSL certificate", permissionHint: "SSL and certificates read", pathTemplate: "/zones/%Z/custom_certificates" },
  ];

  const zoneCollectors: Collector[] = zoneSpecs.map((spec) =>
    listCollector({
      ...spec,
      scope: "zone",
      path: (_a, z) => spec.pathTemplate.replace("%Z", z?.id ?? ""),
    }),
  );

  return [
    accountCollector,
    ...accountCollectors,
    r2BucketsCollector,
    workersCronCollector,
    pagesDeploymentsCollector,
    wafAccountRulesetsCollector,
    wafZoneRulesetsCollector,
    ...zoneCollectors,
  ];
}
