// Minimal Cloudflare API client: auth, pagination (page- and cursor-based),
// 429/5xx retry with backoff, and error classification.

const API_BASE = process.env.CFH_API_BASE || "https://api.cloudflare.com/client/v4";

export type ErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "bad_request"
  | "server"
  | "network"
  | "other";

export class CFApiError extends Error {
  readonly kind: ErrorKind;
  readonly status: number | null;
  readonly code: number | null;

  constructor(kind: ErrorKind, message: string, status: number | null = null, code: number | null = null) {
    super(message);
    this.name = "CFApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

interface CFResponse<T = unknown> {
  success?: boolean;
  result: T;
  result_info?: Record<string, unknown>;
  errors?: Array<{ code?: number; message?: string }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function kindFromStatus(status: number): ErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "bad_request";
  if (status >= 500) return "server";
  return "other";
}

export class CFApiClient {
  constructor(
    readonly token: string,
    readonly accountId: string | null,
  ) {}

  private url(path: string, query?: Record<string, unknown>): string {
    const u = new URL(API_BASE + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<{ result: T; resultInfo: Record<string, unknown> }> {
    const maxAttempts = 4;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.url(path, opts.query), {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(45_000),
        });
      } catch (err) {
        if (attempt >= maxAttempts) {
          throw new CFApiError("network", `network error: ${(err as Error).message}`);
        }
        await sleep(500 * attempt);
        continue;
      }

      if (res.status === 429 && attempt < maxAttempts) {
        const ra = Number.parseFloat(res.headers.get("retry-after") ?? "");
        const wait = Number.isFinite(ra) ? ra * 1000 : 2000 * attempt;
        await sleep(Math.min(wait, 30_000));
        continue;
      }
      if (res.status >= 500 && attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }

      let json: CFResponse<T> | null = null;
      try {
        json = (await res.json()) as CFResponse<T>;
      } catch {
        json = null;
      }

      if (json && json.success === false) {
        const e0 = json.errors?.[0];
        throw new CFApiError(
          kindFromStatus(res.status),
          e0?.message ?? `API error (HTTP ${res.status})`,
          res.status,
          e0?.code ?? null,
        );
      }
      if (!res.ok) throw new CFApiError(kindFromStatus(res.status), `HTTP ${res.status}`, res.status);

      return {
        result: (json?.result ?? null) as T,
        resultInfo: (json?.result_info ?? {}) as Record<string, unknown>,
      };
    }
  }

  get<T = unknown>(path: string, query?: Record<string, unknown>) {
    return this.request<T>("GET", path, { query });
  }

  /** Page-based listing (per_page/page + result_info.total_pages). */
  async listAll(
    path: string,
    params: Record<string, unknown> = {},
    opts: { maxPages?: number; perPage?: number; unwrap?: (result: unknown) => unknown[] } = {},
  ): Promise<unknown[]> {
    const maxPages = opts.maxPages ?? 100;
    const perPage = opts.perPage ?? 50;
    const unwrap = opts.unwrap ?? ((r: unknown) => (Array.isArray(r) ? r : []));
    const out: unknown[] = [];
    let page = 1;
    for (;;) {
      const { result, resultInfo } = await this.get(path, { ...params, per_page: perPage, page });
      const arr = unwrap(result);
      out.push(...arr);
      let totalPages: number | undefined;
      if (typeof resultInfo.total_pages === "number") totalPages = resultInfo.total_pages;
      else if (typeof resultInfo.total_count === "number") {
        const pp = typeof resultInfo.per_page === "number" ? resultInfo.per_page : perPage;
        totalPages = Math.ceil(resultInfo.total_count / pp);
      }
      if (!totalPages || page >= totalPages || arr.length === 0 || page >= maxPages) break;
      page++;
    }
    return out;
  }

  /**
   * Cursor- or page-based listing. Audit Logs v2 paginates with result_info.cursor;
   * most other endpoints use page numbers. Tries cursor first, falls back to pages.
   */
  async listAuto(
    path: string,
    params: Record<string, unknown> = {},
    opts: { maxPages?: number; perPage?: number } = {},
  ): Promise<unknown[]> {
    const maxPages = opts.maxPages ?? 1000;
    const perPage = opts.perPage ?? 50;
    const out: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const q: Record<string, unknown> = { ...params, per_page: perPage };
      if (cursor !== undefined) q.cursor = cursor;
      else if (pages > 0) q.page = pages + 1;
      const { result, resultInfo } = await this.get(path, q);
      const arr = Array.isArray(result) ? result : [];
      out.push(...arr);
      pages++;
      const nextCursor = resultInfo.cursor;
      if (typeof nextCursor === "string" && nextCursor !== "") {
        if (pages >= maxPages || nextCursor === cursor) break;
        cursor = nextCursor;
        continue;
      }
      const totalPages = typeof resultInfo.total_pages === "number" ? resultInfo.total_pages : 0;
      if (totalPages > pages && pages < maxPages && arr.length > 0) continue;
      break;
    }
    return out;
  }
}
