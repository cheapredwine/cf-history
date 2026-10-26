// Join the inventory with the audit-log index: fill modified_by where the
// object API didn't provide it, keep the API value (with an audit
// corroboration note) where it did, and drop objects that have neither
// timestamps nor any audit trail.

import type { Row } from "./types.js";
import type { AuditIndexEntry } from "./audit.js";
import { appendNote } from "./util.js";

export interface JoinStats {
  dropped: number;
  auditFilled: number;
  auditCorroborated: number;
}

export function joinAudit(
  rows: Row[],
  index: Map<string, AuditIndexEntry>,
): { rows: Row[]; stats: JoinStats } {
  const kept: Row[] = [];
  let dropped = 0;
  let auditFilled = 0;
  let auditCorroborated = 0;

  for (const row of rows) {
    const e = index.get(row.object_id);
    const hasTs = row.created_at !== null || row.modified_at !== null;
    if (!hasTs && !e) {
      dropped++;
      continue;
    }

    if (e) {
      if (row.modified_by) {
        // The object API already says who changed it last; audit log corroborates.
        row.modified_by_source = "api";
        row.notes = appendNote(row.notes, `audit corroboration: ${e.actionType} by ${e.actor} at ${e.time}`);
        auditCorroborated++;
      } else {
        const auditTime = e.time !== "" ? Date.parse(e.time) : 0;
        if (!row.modified_at || (auditTime && auditTime > Date.parse(row.modified_at))) {
          row.modified_at = e.time || row.modified_at;
        }
        row.modified_by = e.actor;
        row.modified_by_source = "audit";
        row.notes = appendNote(
          row.notes,
          `audit: ${e.actionType}${e.actionDesc ? ` (${e.actionDesc})` : ""} via ${e.context || "unknown"}`,
        );
        auditFilled++;
      }
    } else {
      row.modified_by_source = row.modified_by ? "api" : "none";
    }
    kept.push(row);
  }

  return { rows: kept, stats: { dropped, auditFilled, auditCorroborated } };
}
