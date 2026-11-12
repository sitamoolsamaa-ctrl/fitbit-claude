/**
 * Minimal client for the Google Health API v4 (the Fitbit-data cloud API).
 * Docs: https://developers.google.com/health/reference/rest/v4
 */

import { toCivilDate, nextDayIso, buildTimeFilter, todayIso } from "./dates";

const HEALTH_BASE = "https://health.googleapis.com/v4";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Past days never change, so cache them for a long time (30 days). */
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Transient (retryable) HTTP statuses and how many times we'll back off. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
/** Stop following pagination after this many pages (safety against loops). */
const MAX_PAGES = 50;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface GoogleHealthClientOptions {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  clientSecret: string;
  cache?: KVNamespace;
  userId?: string;
  timeZone?: string;
}

export class GoogleHealthClient {
  private accessToken: string;
  private readonly refreshToken?: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly cache?: KVNamespace;
  private readonly userId: string;
  private readonly timeZone: string;

  constructor(opts: GoogleHealthClientOptions) {
    this.accessToken = opts.accessToken;
    this.refreshToken = opts.refreshToken;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.cache = opts.cache;
    this.userId = opts.userId ?? "anon";
    this.timeZone = opts.timeZone ?? "UTC";
  }

  private async withCache(
    keyParts: unknown[],
    endDate: string,
    fetcher: () => Promise<unknown>,
  ): Promise<unknown> {
    const cacheable = this.cache && endDate < todayIso(this.timeZone);
    if (!cacheable) return fetcher();

    const key = `v1:${this.userId}:${JSON.stringify(keyParts)}`;
    try {
      const hit = await this.cache!.get(key, "json");
      if (hit !== null) return hit;
    } catch {
      // Treat a cache read error as a miss.
    }

    const result = await fetcher();
    try {
      await this.cache!.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
    } catch {
      // A failed write just means no caching this time.
    }
    return result;
  }

  async dailyRollUp(
    dataType: string,
    startDate: string,
    endDate: string,
  ): Promise<unknown> {
    const url = `${HEALTH_BASE}/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`;
    const range = {
      start: { date: toCivilDate(startDate) },
      end: { date: toCivilDate(nextDayIso(endDate)) },
    };
    return this.withCache(["dailyRollUp", dataType, startDate, endDate], endDate, () =>
      this.paginate("rollupDataPoints", (pageToken) =>
        this.request(url, {
          method: "POST",
          body: JSON.stringify(pageToken ? { range, pageToken } : { range }),
        }),
      ),
    );
  }

  async list(
    dataType: string,
    startTime: string,
    endTime: string,
    pageSize?: number,
  ): Promise<unknown> {
    const field = `${dataType.replace(/-/g, "_")}.interval.start_time`;
    const filter = `${field} >= "${startTime}" AND ${field} < "${endTime}"`;
    return this.paginate("dataPoints", (pageToken) => {
      const params = new URLSearchParams({ filter });
      if (pageSize) params.set("pageSize", String(pageSize));
      if (pageToken) params.set("pageToken", pageToken);
      const url = `${HEALTH_BASE}/users/me/dataTypes/${dataType}/dataPoints?${params}`;
      return this.request(url, { method: "GET" });
    });
  }

  async reconcile(
    dataType: string,
    startDate: string,
    endDate: string,
    opts: { timeMember?: string; dataSourceFamily?: string; physical?: boolean } = {},
  ): Promise<unknown> {
    const filter = buildTimeFilter(dataType, startDate, endDate, {
      timeMember: opts.timeMember,
      physical: opts.physical,
    });
    const cacheKey = ["reconcile", dataType, startDate, endDate, opts.timeMember, opts.physical, opts.dataSourceFamily];
    return this.withCache(cacheKey, endDate, () =>
      this.paginate("dataPoints", (pageToken) => {
        const params = new URLSearchParams({ filter });
        if (opts.dataSourceFamily) params.set("dataSourceFamily", opts.dataSourceFamily);
        if (pageToken) params.set("pageToken", pageToken);
        const url = `${HEALTH_BASE}/users/me/dataTypes/${dataType}/dataPoints:reconcile?${params}`;
        return this.request(url, { method: "GET" });
      }),
    );
  }

  async listByDate(
    dataType: string,
    startDate: string,
    endDate: string,
    opts: { timeMember?: string; physical?: boolean; pageSize?: number } = {},
  ): Promise<unknown> {
    const filter = buildTimeFilter(dataType, startDate, endDate, {
      timeMember: opts.timeMember,
      physical: opts.physical,
    });
    const cacheKey = ["listByDate", dataType, startDate, endDate, opts.timeMember, opts.physical];
    return this.withCache(cacheKey, endDate, () =>
      this.paginate("dataPoints", (pageToken) => {
        const params = new URLSearchParams({ filter });
        if (opts.pageSize) params.set("pageSize", String(opts.pageSize));
        if (pageToken) params.set("pageToken", pageToken);
        const url = `${HEALTH_BASE}/users/me/dataTypes/${dataType}/dataPoints?${params}`;
        return this.request(url, { method: "GET" });
      }),
    );
  }

  /**
   * Create a single data point (write), e.g. a nutrition-log entry.
   * Requires the matching write scope (googlehealth.nutrition.writeonly).
   */
  async createDataPoint(dataType: string, body: unknown): Promise<unknown> {
    const url = `${HEALTH_BASE}/users/me/dataTypes/${dataType}/dataPoints`;
    return this.request(url, { method: "POST", body: JSON.stringify(body) });
  }

  private async paginate(
    arrayKey: "dataPoints" | "rollupDataPoints",
    fetchPage: (pageToken?: string) => Promise<unknown>,
  ): Promise<unknown> {
    const merged = (await fetchPage()) as Record<string, unknown>;
    const hadKey = Array.isArray(merged[arrayKey]);
    const items = hadKey ? (merged[arrayKey] as unknown[]) : [];
    let token = merged.nextPageToken as string | undefined;

    for (let page = 1; token && page < MAX_PAGES; page++) {
      const next = (await fetchPage(token)) as Record<string, unknown>;
      if (Array.isArray(next[arrayKey])) items.push(...(next[arrayKey] as unknown[]));
      token = next.nextPageToken as string | undefined;
    }

    if (!hadKey && items.length === 0) {
      delete merged.nextPageToken;
      return merged;
    }

    merged[arrayKey] = items;
    delete merged.nextPageToken;
    return merged;
  }

  private async request(
    url: string,
    init: RequestInit,
    state: { authRetried: boolean; attempt: number } = { authRetried: false, attempt: 0 },
  ): Promise<unknown> {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (res.status === 401 && this.refreshToken && !state.authRetried) {
      await this.refresh();
      return this.request(url, init, { ...state, authRetried: true });
    }

    if (RETRYABLE_STATUSES.has(res.status) && state.attempt < MAX_RETRIES) {
      await sleep(this.backoffMs(res, state.attempt));
      return this.request(url, init, { ...state, attempt: state.attempt + 1 });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Google Health API ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      );
    }
    return res.json();
  }

  private backoffMs(res: Response, attempt: number): number {
    const retryAfter = res.headers.get("Retry-After");
    if (retryAfter) {
      const secs = parseInt(retryAfter, 10);
      if (!Number.isNaN(secs)) return Math.min(secs * 1000, 10_000);
    }
    return Math.min(2 ** attempt * 300 + Math.random() * 200, 5_000);
  }

  private async refresh(): Promise<void> {
    if (!this.refreshToken) throw new Error("No refresh token available");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token: string };
    this.accessToken = json.access_token;
  }
}
