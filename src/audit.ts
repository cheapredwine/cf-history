// Audit Logs v2 collector: builds resource_id -> {actor, time, action} index.
// This is the "last modified by" backbone: almost no Cloudflare object API
// returns *who* made the last change, but audit logs record it for ~95% of
// products. Entries older than the ~18 month retention window are gone, which
// is reported as an honest gap rather than silently blank.

import { CFApiClient, CFApiError } from "./client.js";
import type { CollectorOutcome } from "./types.js";

export interface AuditIndexEntry {
  actor: string;
  actorType: string;
  time: string;
  actionType: string;
  actionDesc: string;
  context: string;
  zoneId: string | null;
}

export interface AuditResult {
  index: Map<string, AuditIndexEntry>;
  entries: number;
  outcome: CollectorOutcome;
  message: string | null;
  window: { since: string; before: string };
}

const RETENTION_DAYS = 545; // ~18 months of Audit Logs v2 retention

export function auditWindow(since?: Date): { since: Date; before: Date } {
  const before = new Date();
  const floor = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  return { since: since && since > floor ? since : floor, before };
}

export async function collectAuditIndex(
  client: CFApiClient,
  accountId: string,
  since?: Date,
  log: (m: string) => void = () => {},
): Promise<AuditResult> {
  const win = auditWindow(since);
  const iso = (d: Date) => d.toISOString();
  const window = { since: iso(win.since), before: iso(win.before) };
  const fail = (outcome: CollectorOutcome, message: string): AuditResult => ({
    index: new Map(),
    entries: 0,
    outcome,
    message,
    window,
  });

  try {
    // Required params: since & before (RFC3339 or YYYY-MM-DD). Cursor-paginated.
    const entries = await client.listAuto(
      `/accounts/${accountId}/logs/audit`,
      { since: window.since, before: window.before },
      { maxPages: 2000 },
    );
    log(`audit logs: ${entries.length} entries fetched`);
    const index = new Map<string, AuditIndexEntry>();

    for (const e of entries as any[]) {
      // Two shapes exist in the wild:
      //  v2:   action: {type, description, result, time}, actor: {email, id, type, context},
      //        resource: {id, ...}, zone: {id}
      //  flat: action: "dns.records.update", actor: {email, id},
      //        resources: [{resource_id, resource_type}], timestamp, interface
      const actionObj = e && typeof e.action === "object" && e.action !== null ? e.action : null;
      const actionType = String(actionObj?.type ?? (typeof e.action === "string" ? e.action : "")).toLowerCase();
      if (actionType === "" || actionType === "view") continue; // views don't modify anything
      const result = String(actionObj?.result ?? "success");
      if (result !== "success") continue; // failed actions didn't change anything
      const time =
        (typeof actionObj?.time === "string" && actionObj.time) ||
        (typeof e.timestamp === "string" && e.timestamp) ||
        "";

      const actor = (e?.actor ?? {}) as Record<string, unknown>;
      const actorType = String(actor.type ?? "unknown");
      const actorLabel =
        (typeof actor.email === "string" && actor.email !== "" && actor.email) ||
        (typeof actor.id === "string" && actor.id !== "" && actor.id) ||
        actorType;
      const context = String(actor.context ?? e.interface ?? "");
      const zoneId = e?.zone?.id != null ? String(e.zone.id) : null;

      const ids = new Set<string>();
      if (e?.resource?.id != null) ids.add(String(e.resource.id));
      if (Array.isArray(e?.resources)) {
        for (const r of e.resources) if (r?.resource_id != null) ids.add(String(r.resource_id));
      }

      for (const id of ids) {
        const prev = index.get(id);
        const newer = !prev || prev.time === "" || (time !== "" && new Date(time) > new Date(prev.time));
        if (newer) {
          index.set(id, {
            actor: actorLabel,
            actorType,
            time: time || prev?.time || "",
            actionType,
            actionDesc: String(actionObj?.description ?? ""),
            context,
            zoneId,
          });
        }
      }
    }

    return {
      index,
      entries: entries.length,
      outcome: "collected",
      message: entries.length === 0 ? "no audit entries in window" : null,
      window,
    };
  } catch (err) {
    if (err instanceof CFApiError) {
      if (err.kind === "forbidden") {
        return fail("forbidden", "needs Account Settings read permission (audit logs)");
      }
      if (err.kind === "not_found") {
        return fail("not_found", "audit logs v2 not available on this account");
      }
      return fail("error", err.message);
    }
    return fail("error", (err as Error)?.message ?? String(err));
  }
}
