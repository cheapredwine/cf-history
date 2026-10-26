import type { CFApiClient } from "./client.js";

export interface ZoneInfo {
  id: string;
  name: string;
}

/** One flattened inventory row; this is also the CSV column set (see report.ts). */
export interface Row {
  object_type: string;
  domain: string;
  scope: "account" | "zone";
  account_name: string;
  zone_name: string | null;
  object_id: string;
  object_name: string;
  created_at: string | null;
  created_by: string | null;
  modified_at: string | null;
  modified_by: string | null;
  /** api = the object API exposed it; audit = filled from Audit Logs v2; none = unknown */
  modified_by_source: "api" | "audit" | "none";
  notes: string | null;
}

export type CollectorOutcome = "collected" | "forbidden" | "not_found" | "error" | "skipped";

export interface CollectorStatus {
  id: string;
  label: string;
  domain: string;
  scope: "account" | "zone";
  permissionHint: string;
  outcome: CollectorOutcome;
  rows: number;
  message: string | null;
}

export interface RunCtx {
  client: CFApiClient;
  accountId: string;
  accountName: string;
  log: (msg: string) => void;
}

export interface CollectOneResult {
  rows: Row[];
  outcome: CollectorOutcome;
  message: string | null;
}

export interface Collector {
  id: string;
  label: string;
  domain: string;
  scope: "account" | "zone";
  permissionHint: string;
  runOne: (ctx: RunCtx, zone?: ZoneInfo) => Promise<CollectOneResult>;
}
