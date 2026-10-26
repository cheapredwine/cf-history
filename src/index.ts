#!/usr/bin/env node
// cf-history — pulls last-modified / last-modified-by metadata for as many
// objects in a Cloudflare account as expose it. Two passes: an inventory pass
// over object APIs, plus an Audit Logs v2 pass that fills in "who changed it".

import { CFApiClient, CFApiError } from "./client.js";
import { collectAuditIndex } from "./audit.js";
import { buildCollectors, makeRow } from "./catalog.js";
import { joinAudit } from "./join.js";
import { runDoctor } from "./doctor.js";
import { writeReports } from "./report.js";
import { fmtShort, pad, parseSince, runPool, trunc } from "./util.js";
import type { Collector, CollectorStatus, Row, RunCtx, ZoneInfo } from "./types.js";

interface Args {
  account?: string;
  doctor: boolean;
  coverage: boolean;
  since?: string;
  type?: string;
  out: string;
  jsonOnly: boolean;
  csvOnly: boolean;
  verbose: boolean;
}

function usage(): void {
  console.log(`cf-history — last-modified / last-modified-by across a Cloudflare account

Usage:
  pnpm start [-- --account <id>] [--doctor] [--coverage] [--since 30d] [--type dns] [--out ./out]

Options:
  --account <id>   Account ID (default: CLOUDFLARE_ACCOUNT_ID, or auto-detect if exactly one)
  --doctor         Verify the token and report which permissions are missing
  --coverage       Print the per-endpoint collection report and exit
  --since <when>   Only include objects modified/created after this (e.g. 30d, 6mo, 2025-01-01)
  --type <substr>  Filter rows by domain/object type substring (e.g. dns, worker, access)
  --out <dir>      Output directory (default: current directory)
  --json-only      Write JSON only
  --csv-only       Write CSV only
  --verbose        Progress logging

Environment:
  CLOUDFLARE_API_TOKEN   required (read-scoped API token, see README)
  CLOUDFLARE_ACCOUNT_ID  optional when --account is used
  R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY  optional, enables R2 listing via S3 API
`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { doctor: false, coverage: false, out: ".", jsonOnly: false, csvOnly: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--account": args.account = argv[++i]; break;
      case "--doctor": args.doctor = true; break;
      case "--coverage": args.coverage = true; break;
      case "--since": args.since = argv[++i]; break;
      case "--type": args.type = argv[++i]; break;
      case "--out": args.out = argv[++i]; break;
      case "--json-only": args.jsonOnly = true; break;
      case "--csv-only": args.csvOnly = true; break;
      case "--verbose": args.verbose = true; break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      case "--":
        continue; // separator, ignore
      default:
        console.error(`unknown argument: ${a}\n`);
        usage();
        process.exit(2);
    }
  }
  if (args.jsonOnly && args.csvOnly) {
    console.error("--json-only and --csv-only are mutually exclusive");
    process.exit(2);
  }
  return args;
}

interface MergedStatus extends CollectorStatus {
  okCount: number;
  totalCount: number;
  firstFailure: string | null;
}

function newStatus(s: CollectorStatus, total = 1): MergedStatus {
  return {
    ...s,
    okCount: s.outcome === "collected" ? 1 : 0,
    totalCount: total,
    firstFailure: s.outcome === "collected" ? null : `${s.outcome}${s.message ? `: ${s.message}` : ""}`,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    console.error("CLOUDFLARE_API_TOKEN is not set. Create a read-scoped API token (see README) and export it.");
    process.exit(2);
  }

  const accountId0 = args.account ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? null;
  const client = new CFApiClient(token, accountId0);
  const progress = (m: string) => console.error(m);

  if (args.doctor) {
    await runDoctor(client, args.account ?? null);
    return;
  }

  // ---- resolve account ------------------------------------------------------
  let accountId: string;
  let accountName: string | null = null;
  if (accountId0) {
    accountId = accountId0;
  } else {
    try {
      const accounts = await client.listAll("/accounts");
      if (accounts.length === 1) {
        accountId = String((accounts[0] as any).id);
      } else {
        console.error(
          `Could not auto-detect the account: token sees ${accounts.length}. Set CLOUDFLARE_ACCOUNT_ID or pass --account.`,
        );
        process.exit(2);
      }
    } catch (err) {
      console.error(`Could not list accounts: ${(err as Error).message}`);
      process.exit(2);
    }
  }
  try {
    const { result } = await client.get(`/accounts/${accountId}`);
    accountName = String((result as any)?.name ?? accountId);
  } catch {
    accountName = accountId;
  }

  const statuses = new Map<string, MergedStatus>();

  // ---- zones ----------------------------------------------------------------
  const zones: ZoneInfo[] = [];
  const rows: Row[] = [];
  try {
    const zoneObjs = (await client.listAll("/zones", { "account.id": accountId })) as any[];
    for (const z of zoneObjs) {
      const id = String(z?.id ?? "");
      const name = String(z?.name ?? "");
      if (id === "" || name === "") continue;
      zones.push({ id, name });
      rows.push(
        makeRow({
          ctx: { client, accountId, accountName, log: () => {} },
          zoneName: name,
          objectType: "Zone",
          domain: "Zones",
          scope: "zone",
          id,
          name,
          obj: z,
          notes: z?.status ? `status=${z.status}${z?.plan?.name ? ` plan=${z.plan.name}` : ""}` : null,
        }),
      );
    }
    statuses.set(
      "zones",
      newStatus({
        id: "zones",
        label: "Zones",
        domain: "Zones",
        scope: "account",
        permissionHint: "Zone read",
        outcome: "collected",
        rows: zones.length,
        message: zones.length === 0 ? "no zones in account" : null,
      }),
    );
  } catch (err) {
    statuses.set(
      "zones",
      newStatus({
        id: "zones",
        label: "Zones",
        domain: "Zones",
        scope: "account",
        permissionHint: "Zone read",
        outcome: err instanceof CFApiError && err.kind === "forbidden" ? "forbidden" : "error",
        rows: 0,
        message: (err as Error).message,
      }),
    );
  }

  // ---- collectors -----------------------------------------------------------
  const ctx: RunCtx = { client, accountId, accountName, log: args.verbose ? progress : () => {} };
  const collectors = buildCollectors();
  const tasks: Array<{ collector: Collector; zone?: ZoneInfo }> = [];
  for (const c of collectors) {
    if (c.scope === "account") {
      tasks.push({ collector: c });
    } else if (zones.length === 0) {
      if (!statuses.has(c.id)) {
        statuses.set(
          c.id,
          newStatus({
            id: c.id, label: c.label, domain: c.domain, scope: c.scope, permissionHint: c.permissionHint,
            outcome: "skipped", rows: 0, message: "no zones accessible",
          }),
        );
      }
    } else {
      for (const z of zones) tasks.push({ collector: c, zone: z });
    }
  }

  await runPool(tasks, 4, async (t) => {
    let res;
    try {
      res = await t.collector.runOne(ctx, t.zone);
    } catch (err) {
      res = { rows: [], outcome: "error" as const, message: (err as Error).message };
    }
    if (args.verbose) {
      progress(`  [${t.collector.id}${t.zone ? ` / ${t.zone.name}` : ""}] ${res.outcome} rows=${res.rows.length}${res.message ? ` (${res.message})` : ""}`);
    }
    const prev = statuses.get(t.collector.id);
    if (!prev) {
      statuses.set(
        t.collector.id,
        newStatus(
          {
            id: t.collector.id, label: t.collector.label, domain: t.collector.domain,
            scope: t.collector.scope, permissionHint: t.collector.permissionHint,
            outcome: res.outcome, rows: res.rows.length, message: res.message,
          },
        ),
      );
    } else {
      prev.rows += res.rows.length;
      prev.totalCount++;
      if (res.outcome === "collected") prev.okCount++;
      else if (!prev.firstFailure) prev.firstFailure = `${res.outcome}${res.message ? `: ${res.message}` : ""}`;
    }
    rows.push(...res.rows);
  });

  // ---- audit pass + join ------------------------------------------------------
  const sinceDate = args.since ? parseSince(args.since) : undefined;
  const audit = await collectAuditIndex(client, accountId, sinceDate, args.verbose ? progress : () => {});
  statuses.set(
    "audit_logs_v2",
    newStatus({
      id: "audit_logs_v2",
      label: "Audit logs v2 (who changed what)",
      domain: "Audit",
      scope: "account",
      permissionHint: "Account settings read",
      outcome: audit.outcome,
      rows: audit.entries,
      message: audit.message,
    }),
  );

  const joined = joinAudit(rows, audit.index);
  let finalRows = joined.rows;

  // ---- coverage ---------------------------------------------------------------
  const coverage = [...statuses.values()].map((s) => {
    const outcome = s.okCount > 0 ? ("collected" as const) : s.outcome;
    const message =
      s.okCount > 0 && s.okCount < s.totalCount && s.firstFailure
        ? `collected ${s.okCount}/${s.totalCount} zone(s); first failure — ${s.firstFailure}`
        : s.okCount === 0 && s.firstFailure
          ? s.firstFailure
          : s.message;
    return { ...s, outcome, message };
  });

  if (args.coverage) {
    for (const c of coverage) {
      console.log(`${pad(c.id, 28)} ${pad(c.outcome, 10)} ${pad(String(c.rows), 6)} rows  ${c.message ?? ""}`);
    }
    return;
  }

  // ---- filters ----------------------------------------------------------------
  if (args.type) {
    const needle = args.type.toLowerCase();
    finalRows = finalRows.filter((r) =>
      `${r.domain} ${r.object_type} ${r.zone_name ?? ""}`.toLowerCase().includes(needle),
    );
  }
  if (args.since) {
    const cutoff = sinceDate!.getTime();
    const before = finalRows.length;
    finalRows = finalRows.filter((r) => {
      const t = r.modified_at ?? r.created_at;
      return t !== null && Date.parse(t) >= cutoff;
    });
    const excluded = before - finalRows.length;
    if (excluded > 0) progress(`--since excluded ${excluded} row(s) without a recent timestamp`);
  }

  // ---- sort + summarize ---------------------------------------------------------
  finalRows.sort((a, b) => {
    const am = a.modified_at ? Date.parse(a.modified_at) : 0;
    const bm = b.modified_at ? Date.parse(b.modified_at) : 0;
    if (am !== bm) return bm - am;
    const ac = a.created_at ? Date.parse(a.created_at) : 0;
    const bc = b.created_at ? Date.parse(b.created_at) : 0;
    if (ac !== bc) return bc - ac;
    return a.object_name.localeCompare(b.object_name);
  });

  const byDomain = new Map<string, { objects: number; withBy: number; viaApi: number; viaAudit: number }>();
  for (const r of finalRows) {
    const d = byDomain.get(r.domain) ?? { objects: 0, withBy: 0, viaApi: 0, viaAudit: 0 };
    d.objects++;
    if (r.modified_by) {
      d.withBy++;
      if (r.modified_by_source === "api") d.viaApi++;
      else if (r.modified_by_source === "audit") d.viaAudit++;
    }
    byDomain.set(r.domain, d);
  }

  const payload = {
    tool: "cf-history",
    generated_at: new Date().toISOString(),
    account: { id: accountId, name: accountName },
    zones: zones.length,
    audit: {
      outcome: audit.outcome,
      entries: audit.entries,
      window: audit.window,
      message: audit.message,
    },
    filters: { since: args.since ?? null, type: args.type ?? null },
    totals: {
      objects: finalRows.length,
      with_modified_by: finalRows.filter((r) => r.modified_by).length,
      via_api: finalRows.filter((r) => r.modified_by_source === "api").length,
      via_audit: finalRows.filter((r) => r.modified_by_source === "audit").length,
      dropped_without_timestamps_or_audit: joined.stats.dropped,
    },
    coverage,
    rows: finalRows,
  };

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const baseName = `cf-history-${accountId.slice(0, 8)}-${stamp}`;
  const files = writeReports(args.out, baseName, payload, { json: !args.csvOnly, csv: !args.jsonOnly });

  // ---- report -----------------------------------------------------------------
  console.log(`cf-history — ${accountName} (${accountId})`);
  console.log(
    `zones: ${zones.length}   objects: ${finalRows.length}   audit entries: ${audit.entries} (window since ${audit.window.since.slice(0, 10)})`,
  );
  if (joined.stats.dropped > 0) {
    console.log(`excluded ${joined.stats.dropped} object(s) with no timestamps and no audit trail`);
  }
  console.log("");
  console.log("by domain:");
  for (const [d, s] of [...byDomain.entries()].sort((x, y) => y[1].objects - x[1].objects)) {
    console.log(`  ${pad(d, 16)} ${pad(String(s.objects), 7)} objects   ${s.withBy} with modified-by (${s.viaApi} api, ${s.viaAudit} audit)`);
  }
  const problems = coverage.filter((c) => c.outcome !== "collected");
  if (problems.length > 0) {
    console.log("");
    console.log("not collected (add read permissions, see README):");
    for (const p of problems) {
      console.log(`  ${pad(p.id, 28)} ${pad(p.outcome, 10)} ${p.message ?? ""}`);
    }
  }
  console.log("");
  console.log("most recently modified:");
  for (const r of finalRows.slice(0, 15)) {
    console.log(
      `  ${pad(fmtShort(r.modified_at ?? r.created_at), 18)} ${pad(r.domain, 15)} ${pad(trunc(r.object_name, 40), 42)} ${r.modified_by ? `${r.modified_by} (${r.modified_by_source})` : "—"}`,
    );
  }
  console.log("");
  console.log(`wrote: ${files.join(", ")}`);

  const anyCollected = [...statuses.values()].some((s) => s.outcome === "collected");
  if (finalRows.length === 0 && !anyCollected) {
    console.error("no data collected — run `pnpm start -- --doctor` to check the token");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
