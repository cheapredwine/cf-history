// Doctor: verify the token and report which permissions/objects are reachable.

import { CFApiClient, CFApiError } from "./client.js";
import { auditWindow } from "./audit.js";
import { pad } from "./util.js";

interface ProbeResult {
  name: string;
  status: string;
  note: string | null;
}

async function probe(client: CFApiClient, name: string, path: string, query?: Record<string, unknown>): Promise<ProbeResult> {
  try {
    await client.get(path, { per_page: 1, ...(query ?? {}) });
    return { name, status: "OK", note: null };
  } catch (err) {
    if (err instanceof CFApiError) {
      if (err.kind === "forbidden") return { name, status: "FORBIDDEN", note: "add the matching read permission to the token" };
      if (err.kind === "not_found") {
        return /deprecated/i.test(err.message)
          ? { name, status: "DEPRECATED", note: err.message }
          : { name, status: "N/A", note: "not available on this account/plan" };
      }
      if (err.kind === "bad_request") return { name, status: "BADREQ", note: err.message };
      return { name, status: `ERR ${err.status ?? ""}`.trim(), note: err.message };
    }
    return { name, status: "ERR", note: (err as Error).message };
  }
}

const ACCOUNT_PROBES: Array<[string, string]> = [
  ["workers_scripts", "/accounts/%A/workers/scripts"],
  ["workers_domains", "/accounts/%A/workers/domains"],
  ["durable_objects", "/accounts/%A/workers/durable_objects/namespaces"],
  ["queues", "/accounts/%A/queues"],
  ["hyperdrive", "/accounts/%A/hyperdrive/configs"],
  ["d1_databases", "/accounts/%A/d1/database"],
  ["kv_namespaces", "/accounts/%A/storage/kv/namespaces"],
  ["r2_buckets", "/accounts/%A/r2/buckets"],
  ["pages_projects", "/accounts/%A/pages/projects"],
  ["access_apps", "/accounts/%A/access/apps"],
  ["access_service_tokens", "/accounts/%A/access/service_tokens"],
  ["access_id_providers", "/accounts/%A/access/identity_providers"],
  ["cfd_tunnels", "/accounts/%A/cfd_tunnel"],
  ["lb_pools", "/accounts/%A/load_balancers/pools"],
  ["registrar_domains", "/accounts/%A/registrar/domains"],
  ["stream_videos", "/accounts/%A/stream"],
  ["turnstile_widgets", "/accounts/%A/challenges/widgets"],
  ["vectorize_indexes", "/accounts/%A/vectorize/v2/indexes"],
  ["account_api_tokens", "/accounts/%A/tokens"],
  ["account_rulesets", "/accounts/%A/rulesets"],
];

const ZONE_PROBES: Array<[string, string]> = [
  ["dns_records", "/zones/%Z/dns_records"],
  ["waf_rulesets", "/zones/%Z/rulesets"],
  ["firewall_rules", "/zones/%Z/firewall/rules"],
  ["ip_access_rules", "/zones/%Z/firewall/access_rules/rules"],
  ["page_rules", "/zones/%Z/pagerules"],
  ["load_balancers", "/zones/%Z/load_balancers"],
  ["workers_routes", "/zones/%Z/workers/routes"],
  ["custom_hostnames", "/zones/%Z/custom_hostnames"],
  ["ssl_cert_packs", "/zones/%Z/ssl/certificate_packs"],
  ["custom_certificates", "/zones/%Z/custom_certificates"],
];

export async function runDoctor(client: CFApiClient, explicitAccount: string | null): Promise<void> {
  console.log("cf-history doctor");
  console.log("=================");
  const results: ProbeResult[] = [];

  try {
    const { result } = await client.get("/user/tokens/verify");
    console.log(`token          OK (${(result as any)?.status ?? "active"})`);
  } catch {
    console.log("token          ?  /user/tokens/verify unavailable (normal for account-owned tokens)");
  }

  let accountId = explicitAccount ?? client.accountId;
  if (!accountId) {
    try {
      const accounts = await client.listAll("/accounts");
      if (accounts.length === 1) {
        accountId = String((accounts[0] as any).id);
        console.log(`account        auto-detected ${accountId}`);
      } else {
        console.log(`account        ?  set CLOUDFLARE_ACCOUNT_ID or --account (token sees ${accounts.length} accounts)`);
      }
    } catch (err) {
      console.log(`account        ERR ${(err as Error).message}`);
    }
  }

  if (accountId) {
    const a = accountId;
    try {
      const { result } = await client.get(`/accounts/${a}`);
      console.log(`account        OK ${((result as any)?.name ?? "").trim()} (${a})`);
      results.push({ name: "account_settings", status: "OK", note: null });
    } catch (err) {
      results.push({
        name: "account_settings",
        status: err instanceof CFApiError && err.kind === "forbidden" ? "FORBIDDEN" : "ERR",
        note: (err as Error).message,
      });
    }
    results.push(await probe(client, "zones_list", "/zones", { "account.id": a }));
    const win = auditWindow();
    results.push(
      await probe(client, "audit_logs_v2", `/accounts/${a}/logs/audit`, {
        since: win.since.toISOString().slice(0, 10),
        before: win.before.toISOString().slice(0, 10),
      }),
    );
    for (const [name, tpl] of ACCOUNT_PROBES) {
      results.push(await probe(client, name, tpl.replace("%A", a)));
    }
  }

  // Zone probes need at least one zone.
  let zoneId: string | null = null;
  try {
    const zones = await client.listAll("/zones", accountId ? { "account.id": accountId } : {}, { maxPages: 1 });
    zoneId = (zones[0] as any)?.id ?? null;
  } catch {
    // zones_list probe already captured the error
  }
  if (zoneId) {
    for (const [name, tpl] of ZONE_PROBES) {
      results.push(await probe(client, name, tpl.replace("%Z", zoneId)));
    }
  } else {
    results.push({ name: "zone_probes", status: "SKIP", note: "no zone available" });
  }

  console.log("");
  for (const r of results) {
    console.log(`${pad(r.name, 26)} ${pad(r.status, 10)} ${r.note ?? ""}`);
  }
  const bad = results.filter((r) => r.status !== "OK" && r.status !== "N/A" && r.status !== "SKIP");
  console.log("");
  console.log(
    bad.length === 0
      ? "all probes OK — run: pnpm start"
      : `${bad.length} probe(s) need attention — add the matching read permissions to the token (see README).`,
  );
}
