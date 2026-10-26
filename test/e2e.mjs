// Offline end-to-end test: spins up a mock Cloudflare API server and runs the
// CLI against it, then verifies the output files. No credentials needed.
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const ZONE = { id: "zone1aaaa", name: "example.test", status: "active", created_on: "2023-01-15T10:00:00Z", modified_on: "2026-10-01T09:30:00Z" };
const DNS1 = { id: "dnsrec1", name: "www.example.test", type: "A", content: "192.0.2.1", created_on: "2024-02-01T00:00:00Z", modified_on: "2024-02-01T00:00:00Z", created_by: "creator@example.test", modified_by: "creator@example.test" };
const DNS2 = { id: "dnsrec2", name: "api.example.test", type: "AAAA", content: "2001:db8::1", created_on: "2024-06-01T00:00:00Z", modified_on: "2026-10-20T08:00:00Z" };
const WORKER = { id: "w1", created_on: "2025-01-01T00:00:00Z", modified_on: "2026-05-05T05:05:05Z" };

const AUDIT_PAGE1 = {
  result: [
    // legacy flat shape
    { action: "dns.records.update", actor: { email: "legacy@example.test", id: "u1" }, interface: "dashboard", resources: [{ resource_id: "dnsrec2", resource_type: "dns_record" }], timestamp: "2026-10-20T08:00:05Z" },
    // v2 nested shape
    { action: { type: "update", description: "Worker updated", result: "success", time: "2026-10-22T10:00:00Z" }, actor: { id: "tok1", type: "account", context: "api", token_name: "ci-token" }, resource: { id: "w1", product: "workers", type: "script" }, zone: null },
  ],
  result_info: { count: 2, cursor: "CURSOR1" },
  success: true,
};
const AUDIT_PAGE2 = {
  result: [
    // view action must be ignored
    { action: { type: "view", result: "success", time: "2026-10-22T23:00:00Z" }, actor: { email: "snooper@example.test" }, resource: { id: "dnsrec1" } },
    // delegated service: latest change to dnsrec1, but API already provides modified_by
    { action: { type: "update", result: "success", time: "2026-10-23T01:00:00Z" }, actor: { type: "delegated_service" }, resource: { id: "dnsrec1" } },
  ],
  result_info: { count: 2, cursor: "" },
  success: true,
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const page = (result) => send(200, { success: true, result, result_info: { page: 1, per_page: 50, count: result.length, total_count: result.length, total_pages: 1 } });

  if (p === "/client/v4/zones") return page([ZONE]);
  if (p === "/client/v4/zones/zone1aaaa/dns_records") return page([DNS1, DNS2]);
  if (p === "/client/v4/accounts/abc123/workers/scripts") return page([WORKER]);
  if (p === "/client/v4/accounts/abc123/logs/audit") {
    return send(200, u.searchParams.get("cursor") === "CURSOR1" ? AUDIT_PAGE2 : AUDIT_PAGE1);
  }
  if (p === "/client/v4/accounts/abc123") return send(200, { success: true, result: { id: "abc123", name: "Mock Account" } });
  // everything else: 404 (exercises the skip paths)
  return send(404, { success: false, errors: [{ code: 7000, message: "not found" }] });
});

const outDir = path.join(root, "test", "out");
fs.rmSync(outDir, { recursive: true, force: true });

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const child = spawn("pnpm", ["start", "--", "--out", outDir, "--account", "abc123"], {
  cwd: root,
  env: { ...process.env, CFH_API_BASE: `http://127.0.0.1:${port}/client/v4`, CLOUDFLARE_API_TOKEN: "mock-token" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => { stdout += d; });
child.stderr.on("data", (d) => { stderr += d; });
const code = await new Promise((r) => child.on("close", r));
server.close();

let data = null;
let jsonPath = null;
let csvPath = null;
try {
  jsonPath = fs.readdirSync(outDir).find((f) => f.endsWith(".json"));
  csvPath = fs.readdirSync(outDir).find((f) => f.endsWith(".csv"));
  data = jsonPath ? JSON.parse(fs.readFileSync(path.join(outDir, jsonPath), "utf8")) : null;
} catch (e) { /* reported below */ }

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });

check("cli exit 0", code === 0, `exit=${code}\nstdout:\n${stdout}\nstderr:\n${stderr.slice(-800)}`);
check("json written", !!jsonPath);
check("csv written", !!csvPath);
check("zones row with timestamps", data?.rows?.some((r) => r.object_type === "Zone" && r.modified_at === ZONE.modified_on && r.created_at === ZONE.created_on));
check("dns api attribution", data?.rows?.some((r) => r.object_id === "dnsrec1" && r.modified_by === "creator@example.test" && r.modified_by_source === "api"));
check("dns audit attribution (legacy shape)", data?.rows?.some((r) => r.object_id === "dnsrec2" && r.modified_by === "legacy@example.test" && r.modified_by_source === "audit"));
check("worker audit attribution (v2 shape)", data?.rows?.some((r) => r.object_id === "w1" && r.modified_by_source === "audit" && r.modified_at === "2026-10-22T10:00:00Z"));
check("view actions ignored", !JSON.stringify(data?.rows ?? []).includes("snooper@example.test"));
check("delegated service surfaced in notes", data?.rows?.some((r) => r.object_id === "dnsrec1" && (r.notes ?? "").includes("delegated_service")));
check("csv has header", csvPath ? fs.readFileSync(path.join(outDir, csvPath), "utf8").startsWith("object_type,domain,scope,") : false);
check("audit collected, 4 entries", data?.audit?.outcome === "collected" && data?.audit?.entries === 4);
check("404s classified as not_found", (data?.coverage ?? []).some((c) => c.outcome === "not_found"));
check("totals consistent", data?.totals?.objects === (data?.rows?.length ?? -1));

let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : ` — ${c.detail}`}`);
  if (!c.ok) failed++;
}
process.exit(failed === 0 ? 0 : 1);
