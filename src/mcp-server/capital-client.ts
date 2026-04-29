// Capital.com REST API Client
// Wraps the Capital.com v1 API with typed methods.
//
// Base URL (demo): https://demo-api-capital.backend-capital.com
// Base URL (live): https://api-capital.backend-capital.com
//
// Auth flow:
//   1. POST /api/v1/session with X-CAP-API-KEY + { identifier, password }
//      → response headers contain CST + X-SECURITY-TOKEN
//   2. Every subsequent request must include BOTH tokens as headers
//   3. Session is idle-timed out after 10 minutes — ping every 9 minutes to keep alive
//   4. On 401 → clear tokens, re-auth once, retry (50ms backoff)
//
// Features supported natively (unlike prior broker):
//   - SL/TP on open
//   - Trailing stops
//   - OHLC historical candles (bid/ask)
//   - Modify position
//   - Close / partial close
//   - Working orders (limit/stop)
//   - Async deal confirmation via /confirms/:dealReference polling

import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type Method,
} from 'axios';
import type {
  Activity,
  CapitalAccount,
  CapitalCandle,
  CapitalPosition,
  Candle,
  CreateWorkingOrderParams,
  DealConfirmation,
  Market,
  MarketDetail,
  OpenPositionParams,
  Resolution,
  Sentiment,
  Timeframe,
  Transaction,
  UpdatePositionParams,
  UpdateWorkingOrderParams,
  WorkingOrder,
} from '../types.js';

// ==================== ERRORS ====================

export class CapitalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapitalAuthError';
  }
}

export class CapitalDealError extends Error {
  public readonly dealReference: string | undefined;
  public readonly reason: string | undefined;

  constructor(message: string, dealReference?: string, reason?: string) {
    super(message);
    this.name = 'CapitalDealError';
    this.dealReference = dealReference;
    this.reason = reason;
  }
}

// ==================== CONSTANTS ====================

const DEFAULT_BASE_URL = 'https://demo-api-capital.backend-capital.com';
const SESSION_IDLE_MS = 9 * 60 * 1000; // 9 minutes (Capital idle-timeout is 10)
// Codex P1 #12 (2026-04-28): increased polling budget from 10×200ms (2s
// total) to 25 attempts with mild exponential backoff (~10s total worst
// case). The prior tight bound caused a real failure mode: Capital
// accepted an order, was slow on /confirms/ (occasionally takes 2-4s
// even when fully accepted), the agent saw a CapitalDealError timeout
// and retried place_order — duplicate live position. The base 200ms
// covers the typical case (~99% confirms in <1s); the long tail goes
// up to ~10s before we give up.
const DEAL_CONFIRM_POLL_BASE_MS = 200;
const DEAL_CONFIRM_MAX_ATTEMPTS = 25;
const DEAL_CONFIRM_BACKOFF_FACTOR = 1.08; // mild backoff: 200, 216, 233, ... up to ~1300ms by attempt 25
const AUTH_RETRY_BACKOFF_MS = 50;

// ==================== TIMEFRAME MAP ====================

const TIMEFRAME_TO_RESOLUTION: Record<Timeframe, Resolution> = {
  '15m': 'MINUTE_15',
  '1h': 'HOUR',
  '4h': 'HOUR_4',
  '1d': 'DAY',
  '1w': 'WEEK',
};

export function timeframeToResolution(tf: Timeframe): Resolution {
  return TIMEFRAME_TO_RESOLUTION[tf];
}

// ==================== CLIENT ====================

export interface CapitalClientConfig {
  apiKey: string;
  identifier: string;
  password: string;
  baseURL?: string;
}

export class CapitalClient {
  private readonly http: AxiosInstance;
  private readonly apiKey: string;
  private readonly identifier: string;
  private readonly password: string;

  private cst: string | null = null;
  private securityToken: string | null = null;
  private lastActivityAt = 0;

  // Single-flight mutex: ensures concurrent requests don't all race to create
  // a session in parallel during cold start or after a 401.
  private sessionPromise: Promise<void> | null = null;

  constructor(config: CapitalClientConfig) {
    this.apiKey = config.apiKey;
    this.identifier = config.identifier;
    this.password = config.password;

    this.http = axios.create({
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
      timeout: 15000,
      // Do NOT throw on non-2xx — we handle status codes manually.
      validateStatus: () => true,
    });
  }

  // ==================== SESSION ====================

  /**
   * Create a new session. Stores CST + X-SECURITY-TOKEN from response headers.
   * Thread-safe via single-flight mutex.
   */
  private async createSession(): Promise<void> {
    if (this.sessionPromise) {
      return this.sessionPromise;
    }

    this.sessionPromise = (async () => {
      try {
        const res = await this.http.request({
          method: 'POST',
          url: '/api/v1/session',
          headers: {
            'X-CAP-API-KEY': this.apiKey,
            'Content-Type': 'application/json',
          },
          data: {
            identifier: this.identifier,
            password: this.password,
            encryptedPassword: false,
          },
        });

        if (res.status !== 200) {
          throw new CapitalAuthError(
            `Session creation failed: HTTP ${res.status} ${this.describeError(res)}`
          );
        }

        const cst = this.extractHeader(res, 'cst');
        const xst = this.extractHeader(res, 'x-security-token');

        if (!cst || !xst) {
          throw new CapitalAuthError(
            'Session creation succeeded but CST / X-SECURITY-TOKEN headers missing from response'
          );
        }

        this.cst = cst;
        this.securityToken = xst;
        this.lastActivityAt = Date.now();
      } finally {
        this.sessionPromise = null;
      }
    })();

    return this.sessionPromise;
  }

  /**
   * Ensure we have a valid session. Called before every request.
   *  - No tokens → create session
   *  - Tokens present but >9min idle → ping; if ping fails, re-create session
   */
  private async ensureSession(): Promise<void> {
    if (!this.cst || !this.securityToken) {
      await this.createSession();
      return;
    }

    const idleFor = Date.now() - this.lastActivityAt;
    if (idleFor > SESSION_IDLE_MS) {
      try {
        await this.pingRaw();
        this.lastActivityAt = Date.now();
      } catch {
        // ping failed → tokens likely stale; clear and recreate
        this.cst = null;
        this.securityToken = null;
        await this.createSession();
      }
    }
  }

  /**
   * Public keep-alive ping. Used by scheduler cron.
   * Capital uses /api/v1/ping for session keep-alive.
   */
  async ping(): Promise<void> {
    await this.ensureSession();
    await this.pingRaw();
    this.lastActivityAt = Date.now();
  }

  /**
   * Raw ping — does NOT call ensureSession (avoids infinite recursion from
   * inside ensureSession's own idle-check path).
   */
  private async pingRaw(): Promise<void> {
    const res = await this.http.request({
      method: 'GET',
      url: '/api/v1/ping',
      headers: this.authHeaders(),
    });
    if (res.status !== 200) {
      throw new CapitalAuthError(`Ping failed: HTTP ${res.status}`);
    }
  }

  /**
   * Gracefully end the session. Errors are swallowed (called on shutdown).
   */
  async logout(): Promise<void> {
    if (!this.cst || !this.securityToken) {
      return;
    }
    try {
      await this.http.request({
        method: 'DELETE',
        url: '/api/v1/session',
        headers: this.authHeaders(),
      });
    } catch {
      // swallow — shutdown path
    } finally {
      this.cst = null;
      this.securityToken = null;
      this.lastActivityAt = 0;
    }
  }

  // ==================== CORE REQUEST ====================

  /**
   * Core authenticated request. Handles:
   *  - lazy session creation via ensureSession()
   *  - single automatic re-auth on 401 (idempotent methods only)
   *  - non-2xx → throws with server-provided error message
   *
   * 2026-04-29 audit-3 fix (broker-audit P0-CC1): the 401 retry path is
   * now restricted to idempotent HTTP methods (GET / HEAD / OPTIONS /
   * DELETE). Pre-fix, a transient 401 on POST /positions (e.g. token
   * expired between Capital's gateway accepting the request and the
   * response leaving) would silently REPLAY the order — placing a
   * duplicate live position with no compensation tracking. For non-
   * idempotent methods, surface the 401 to the caller; the caller must
   * verify the order didn't actually land before deciding to retry.
   */
  private async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    await this.ensureSession();

    const config: AxiosRequestConfig = {
      method,
      url: path,
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      data: body,
    };

    let res = await this.http.request(config);

    if (res.status === 401) {
      const isIdempotent = method === 'GET' || method === 'DELETE';
      if (!isIdempotent) {
        // Non-idempotent (POST/PUT) — DO NOT auto-retry. The request
        // body could have hit Capital's trading engine even if we got
        // 401 back. Caller must reconcile via getOpenPositions/getConfirms
        // before any retry decision.
        throw new CapitalAuthError(
          `Unauthorized on non-idempotent ${method} ${path}; not auto-retrying — caller must verify state on Capital before retry`,
        );
      }
      // Idempotent — safe to re-auth + retry once.
      this.cst = null;
      this.securityToken = null;
      await this.sleep(AUTH_RETRY_BACKOFF_MS);
      await this.createSession();

      config.headers = {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      };
      res = await this.http.request(config);

      if (res.status === 401) {
        throw new CapitalAuthError(
          `Unauthorized after re-auth retry on ${method} ${path}`
        );
      }
    }

    this.lastActivityAt = Date.now();

    if (res.status < 200 || res.status >= 300) {
      const err = new Error(
        `Capital API ${method} ${path} → HTTP ${res.status}: ${this.describeError(res)}`
      );
      // Attach status for callers (e.g. partial-close fallback detection).
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }

    return res.data as T;
  }

  // ==================== ACCOUNT ====================

  async getAccounts(): Promise<CapitalAccount[]> {
    const data = await this.request<{ accounts: CapitalAccount[] }>(
      'GET',
      '/api/v1/accounts'
    );
    return data.accounts ?? [];
  }

  // ==================== POSITIONS ====================

  async getOpenPositions(): Promise<CapitalPosition[]> {
    const data = await this.request<{ positions: CapitalPosition[] }>(
      'GET',
      '/api/v1/positions'
    );
    return data.positions ?? [];
  }

  async getPosition(dealId: string): Promise<CapitalPosition> {
    return this.request<CapitalPosition>('GET', `/api/v1/positions/${dealId}`);
  }

  /**
   * Open a new position.
   * Flow: POST /positions → dealReference → poll /confirms/:ref until ACCEPTED/REJECTED.
   * Rejection → throws CapitalDealError.
   */
  async openPosition(params: OpenPositionParams): Promise<DealConfirmation> {
    const ref = await this.request<{ dealReference: string }>(
      'POST',
      '/api/v1/positions',
      params
    );
    return this.pollDealConfirmation(ref.dealReference);
  }

  async updatePosition(
    dealId: string,
    params: UpdatePositionParams
  ): Promise<DealConfirmation> {
    // 2026-04-29 audit-3 r4 fix (broker-audit P1-CC5): same idempotency
    // pattern as closePosition — if the position auto-closed (e.g.
    // monitor wrote tp1_hit and queued an SL→BE update, but B's SL
    // already triggered between the flag write and the API call),
    // surface a synthetic ALREADY_CLOSED confirmation rather than a
    // generic Error. Lets schedulers/handlers distinguish "transient
    // infra problem" from "race-against-fill" without log spam.
    try {
      const ref = await this.request<{ dealReference: string }>(
        'PUT',
        `/api/v1/positions/${dealId}`,
        params
      );
      return await this.pollDealConfirmation(ref.dealReference);
    } catch (e) {
      if (this.isAlreadyClosed(e)) {
        console.warn(
          `[Capital] updatePosition ${dealId} skipped — position already closed by broker (race against SL/TP fill).`,
        );
        const synthetic: DealConfirmation = {
          dealId,
          dealReference: `synthetic-update-skipped-${dealId}`,
          dealStatus: 'ACCEPTED',
          reason: 'POSITION_ALREADY_CLOSED_BY_BROKER',
          status: 'FULLY_CLOSED',
          direction: 'BUY',
          epic: '',
          size: 0,
          level: 0,
          stopLevel: null,
          profitLevel: null,
          affectedDeals: [{ dealId, status: 'DELETED' }],
        };
        return synthetic;
      }
      throw e;
    }
  }

  async closePosition(dealId: string): Promise<DealConfirmation> {
    // 2026-04-29 audit-3 fix (broker-audit P0-CC3): idempotent against the
    // SL/TP-auto-fill race. If Capital filled the SL/TP microseconds before
    // our DELETE arrived, the API returns 404 / 400 "position does not
    // exist". Pre-fix, this propagated as a generic Error into compensation
    // rollback at trading-agent.ts and produced a spurious "ROLLBACK
    // INCOMPLETE — positions may still be open" Telegram alert — even though
    // the position WAS closed (just by Capital's own SL/TP, not by us).
    // Treat already-closed as a successful close and synthesise a minimal
    // confirmation. The caller's view ("the position is gone") is correct.
    try {
      const ref = await this.request<{ dealReference: string }>(
        'DELETE',
        `/api/v1/positions/${dealId}`
      );
      return await this.pollDealConfirmation(ref.dealReference);
    } catch (e) {
      if (this.isAlreadyClosed(e)) {
        const synthetic: DealConfirmation = {
          dealId,
          dealReference: `synthetic-already-closed-${dealId}`,
          dealStatus: 'ACCEPTED',
          reason: 'ALREADY_CLOSED_BY_BROKER',
          status: 'FULLY_CLOSED',
          direction: 'BUY',
          epic: '',
          size: 0,
          level: 0,
          stopLevel: null,
          profitLevel: null,
          affectedDeals: [{ dealId, status: 'DELETED' }],
        };
        return synthetic;
      }
      throw e;
    }
  }

  /**
   * True when the error indicates the position was already closed (404 / 400
   * with "does not exist" / "position not found" / "closed" wording). Covers
   * Capital.com's documented error vocabulary plus generic 404 fallback.
   */
  private isAlreadyClosed(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    const status = (e as Error & { status?: number }).status;
    if (status === 404) return true;
    const msg = e.message?.toLowerCase() ?? '';
    if (status === 400 || status === 422) {
      return (
        msg.includes('not found') ||
        msg.includes('does not exist') ||
        msg.includes('already closed') ||
        msg.includes('position not exists') ||
        msg.includes('no position')
      );
    }
    return false;
  }

  /**
   * Partial close. Strategy:
   *   1. Try DELETE /positions/:dealId with { size } body.
   *   2. If Capital rejects the partial-size body (400/422), fall back to
   *      full-close + reopen with (original_size - size), preserving SL/TP/trailing.
   */
  async partialClosePosition(
    dealId: string,
    size: number
  ): Promise<DealConfirmation> {
    try {
      const ref = await this.request<{ dealReference: string }>(
        'DELETE',
        `/api/v1/positions/${dealId}`,
        { size }
      );
      return await this.pollDealConfirmation(ref.dealReference);
    } catch (e) {
      if (!this.isPartialCloseUnsupported(e)) {
        throw e;
      }

      // --- Fallback path ---
      // Read position metadata we need to preserve on the reopen.
      const posWrapper = await this.getPosition(dealId);
      const { direction, size: originalSize, stopLevel, profitLevel, trailingStop, trailingStopDistance } =
        posWrapper.position;
      const { epic } = posWrapper.market;

      const remaining = originalSize - size;
      if (remaining <= 0) {
        // Partial size >= position size → just close fully.
        return await this.closePosition(dealId);
      }

      // Full close first.
      await this.closePosition(dealId);

      // Reopen remaining size, preserving SL/TP/trailing.
      const reopenParams: OpenPositionParams = {
        direction,
        epic,
        size: remaining,
      };
      if (stopLevel != null) reopenParams.stopLevel = stopLevel;
      if (profitLevel != null) reopenParams.profitLevel = profitLevel;
      if (trailingStop) {
        reopenParams.trailingStop = true;
        if (trailingStopDistance != null) {
          reopenParams.stopDistance = trailingStopDistance;
        }
      }
      return await this.openPosition(reopenParams);
    }
  }

  // ==================== WORKING ORDERS ====================

  async getWorkingOrders(): Promise<WorkingOrder[]> {
    const data = await this.request<{ workingOrders: WorkingOrder[] }>(
      'GET',
      '/api/v1/workingorders'
    );
    return data.workingOrders ?? [];
  }

  async createWorkingOrder(
    params: CreateWorkingOrderParams
  ): Promise<DealConfirmation> {
    const ref = await this.request<{ dealReference: string }>(
      'POST',
      '/api/v1/workingorders',
      params
    );
    return this.pollDealConfirmation(ref.dealReference);
  }

  async updateWorkingOrder(
    dealId: string,
    params: UpdateWorkingOrderParams
  ): Promise<DealConfirmation> {
    const ref = await this.request<{ dealReference: string }>(
      'PUT',
      `/api/v1/workingorders/${dealId}`,
      params
    );
    return this.pollDealConfirmation(ref.dealReference);
  }

  async deleteWorkingOrder(dealId: string): Promise<DealConfirmation> {
    const ref = await this.request<{ dealReference: string }>(
      'DELETE',
      `/api/v1/workingorders/${dealId}`
    );
    return this.pollDealConfirmation(ref.dealReference);
  }

  // ==================== MARKET DATA ====================

  async searchMarkets(searchTerm: string): Promise<Market[]> {
    const encoded = encodeURIComponent(searchTerm);
    const data = await this.request<{ markets: Market[] }>(
      'GET',
      `/api/v1/markets?searchTerm=${encoded}`
    );
    return data.markets ?? [];
  }

  async getMarketDetails(epic: string): Promise<MarketDetail> {
    return this.request<MarketDetail>('GET', `/api/v1/markets/${epic}`);
  }

  /**
   * Fetch raw Capital candles for an epic.
   * `resolution` is Capital's native enum; callers with Timeframe should use
   * timeframeToResolution() first (or use getCandlesAsCandles()).
   */
  async getCandles(
    epic: string,
    resolution: Resolution,
    max: number,
    from?: string,
    to?: string
  ): Promise<CapitalCandle[]> {
    const params = new URLSearchParams();
    params.set('resolution', resolution);
    params.set('max', String(max));
    if (from) params.set('from', from);
    if (to) params.set('to', to);

    const data = await this.request<{ prices: CapitalCandle[] }>(
      'GET',
      `/api/v1/prices/${epic}?${params.toString()}`
    );
    return data.prices ?? [];
  }

  /**
   * Convenience: fetch candles and convert to the shared `Candle` shape using
   * mid-price (bid + ask) / 2. This is what the rest of the bot consumes.
   */
  async getCandlesAsCandles(
    epic: string,
    timeframe: Timeframe,
    max: number,
    from?: string,
    to?: string
  ): Promise<Candle[]> {
    const raw = await this.getCandles(
      epic,
      timeframeToResolution(timeframe),
      max,
      from,
      to
    );
    return raw.map(capitalCandleToCandle);
  }

  // ==================== HISTORY ====================

  async getActivityHistory(from?: string, to?: string): Promise<Activity[]> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    const path = qs ? `/api/v1/history/activity?${qs}` : '/api/v1/history/activity';
    const data = await this.request<{ activities: Activity[] }>('GET', path);
    return data.activities ?? [];
  }

  async getTransactionHistory(from?: string, to?: string): Promise<Transaction[]> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    const path = qs
      ? `/api/v1/history/transactions?${qs}`
      : '/api/v1/history/transactions';
    const data = await this.request<{ transactions: Transaction[] }>('GET', path);
    return data.transactions ?? [];
  }

  // ==================== SENTIMENT ====================

  async getClientSentiment(marketIds: string[]): Promise<Sentiment[]> {
    if (marketIds.length === 0) return [];
    const encoded = encodeURIComponent(marketIds.join(','));
    const data = await this.request<{ clientSentiments: Sentiment[] }>(
      'GET',
      `/api/v1/clientsentiment?marketIds=${encoded}`
    );
    return data.clientSentiments ?? [];
  }

  // ==================== INTERNAL HELPERS ====================

  /**
   * Poll /confirms/:dealReference with mild exponential backoff (200ms
   * base × 1.08^attempt), up to 25 attempts (~10s worst case).
   * Throws CapitalDealError on REJECTED status or on timeout.
   *
   * IMPORTANT: Capital.com's /confirms/ body returns a top-level `dealId` that
   * is actually the **workingOrderId** (the order/deal event ID), NOT the
   * resulting position's dealId. The position's real dealId lives in
   * `affectedDeals[0].dealId`. Every downstream lookup (GET/DELETE
   * /positions/:id) requires the position dealId, so we normalise here:
   *   - If `affectedDeals` is present and non-empty, override the top-level
   *     `dealId` with `affectedDeals[0].dealId`.
   *   - Otherwise, preserve the top-level `dealId` (e.g. working-order
   *     creations, which use the workingOrderId for subsequent
   *     update/delete calls).
   * All other fields (status, dealStatus, reason, level, size, direction,
   * epic, dealReference, affectedDeals itself) are preserved unchanged.
   */
  private async pollDealConfirmation(
    dealReference: string
  ): Promise<DealConfirmation> {
    for (let attempt = 0; attempt < DEAL_CONFIRM_MAX_ATTEMPTS; attempt++) {
      try {
        const confirmation = await this.request<DealConfirmation>(
          'GET',
          `/api/v1/confirms/${dealReference}`
        );

        if (confirmation.dealStatus === 'REJECTED') {
          throw new CapitalDealError(
            `Deal REJECTED: ${confirmation.reason || 'no reason provided'}`,
            dealReference,
            confirmation.reason
          );
        }

        if (confirmation.dealStatus === 'ACCEPTED') {
          return this.normaliseDealId(confirmation);
        }
        // Any other status → keep polling.
      } catch (e) {
        // If /confirms returned 404 the confirmation isn't ready yet → keep polling.
        if (e instanceof CapitalDealError) throw e;
        const status = (e as Error & { status?: number }).status;
        if (status !== 404 && status !== undefined && status !== 200) {
          throw e;
        }
      }

      if (attempt < DEAL_CONFIRM_MAX_ATTEMPTS - 1) {
        const sleepMs = Math.round(DEAL_CONFIRM_POLL_BASE_MS * Math.pow(DEAL_CONFIRM_BACKOFF_FACTOR, attempt));
        await this.sleep(sleepMs);
      }
    }

    // 2026-04-29 audit-3 r3 fix (broker-audit P0-CC2): before throwing on
    // timeout, reconcile against live state. Capital's /confirms/ can be
    // slow during high-volatility moments (NFP / FOMC / flash events) —
    // exactly when the bot is most likely to be placing orders. If the
    // position is already live on Capital but /confirms/ hasn't flipped
    // ACCEPTED yet, throwing here would propagate as a leg-failure to the
    // caller (trading-agent.ts), which then runs compensation rollback on
    // an empty placedDeals[] — and Capital is left holding a real position
    // the bot has zero awareness of. Worst-case: silent live exposure with
    // no SL/TP linkage in sl_tp_orders, no monitor coverage, no Telegram.
    //
    // Reconcile path: query getOpenPositions() and search for a position
    // whose `dealReference` matches. If found, synthesise an ACCEPTED
    // confirmation from the live position state. If not found, the deal
    // genuinely failed — throw as before.
    try {
      const positions = await this.getOpenPositions();
      const match = positions.find((p) => p.position?.dealReference === dealReference);
      if (match) {
        console.warn(
          `[Capital] /confirms/${dealReference} timed out but position is LIVE on Capital (dealId=${match.position.dealId}). Synthesising confirmation from live state.`,
        );
        const reconciled: DealConfirmation = {
          dealId: match.position.dealId,
          dealReference,
          dealStatus: 'ACCEPTED',
          reason: 'RECONCILED_FROM_LIVE_POSITIONS',
          status: 'OPEN',
          direction: match.position.direction as 'BUY' | 'SELL',
          epic: match.market?.epic ?? '',
          size: match.position.size,
          level: match.position.openLevel,
          stopLevel: match.position.stopLevel ?? null,
          profitLevel: match.position.profitLevel ?? null,
          affectedDeals: [{ dealId: match.position.dealId, status: 'OPENED' }],
        };
        return reconciled;
      }
    } catch (reconcileErr) {
      // If reconcile fails, fall through to the original timeout throw.
      // We don't want to mask the real "deal failed" case behind a
      // network blip on the reconcile path.
      console.error(
        `[Capital] Reconcile via getOpenPositions failed during /confirms/${dealReference} timeout:`,
        reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr),
      );
    }

    throw new CapitalDealError(
      `Deal confirmation timed out after ${DEAL_CONFIRM_MAX_ATTEMPTS} attempts (live-positions reconcile found no match)`,
      dealReference
    );
  }

  /**
   * Normalise a raw /confirms/ response so `dealId` is the position's real
   * dealId rather than Capital's workingOrderId (see pollDealConfirmation
   * docstring for the full explanation of the bug this fixes).
   *
   * Returns a shallow copy with `dealId` overridden to
   * `affectedDeals[0].dealId` when `affectedDeals` is non-empty; otherwise
   * returns the input unchanged. All other fields are preserved as-is.
   */
  private normaliseDealId(confirmation: DealConfirmation): DealConfirmation {
    const affected = confirmation.affectedDeals;
    if (Array.isArray(affected) && affected.length > 0) {
      // 2026-04-29 audit-3 r3 (broker-audit P1-CC4): warn on
      // affectedDeals.length > 1 so we have telemetry if Capital ever
      // returns multi-leg /confirms/ shapes (partial close + reopen,
      // hedge flip, AMENDED status). Picking [0] without validating
      // status could pick a DELETED entry over an OPEN one. Logged so
      // ops can investigate before the bot acts on a stale dealId.
      if (affected.length > 1) {
        const summary = affected.map((d) => `${d.dealId}:${d.status}`).join(',');
        console.warn(
          `[Capital] /confirms/${confirmation.dealReference} returned ${affected.length} affectedDeals — picking [0]. Full list: ${summary}`,
        );
      }
      const positionDealId = affected[0]?.dealId;
      if (typeof positionDealId === 'string' && positionDealId.length > 0) {
        return { ...confirmation, dealId: positionDealId };
      }
    }
    return confirmation;
  }

  private authHeaders(): Record<string, string> {
    if (!this.cst || !this.securityToken) {
      // Callers must go through ensureSession() first.
      throw new CapitalAuthError('No active session tokens');
    }
    return {
      CST: this.cst,
      'X-SECURITY-TOKEN': this.securityToken,
      'X-CAP-API-KEY': this.apiKey,
    };
  }

  private extractHeader(res: AxiosResponse, name: string): string | null {
    const headers = res.headers;
    if (!headers) return null;
    // axios lowercases header names by default, but be defensive.
    const lower = name.toLowerCase();
    const maybe =
      (headers as Record<string, unknown>)[lower] ??
      (headers as Record<string, unknown>)[name];
    if (typeof maybe === 'string' && maybe.length > 0) return maybe;
    return null;
  }

  private describeError(res: AxiosResponse): string {
    const body = res.data as unknown;
    if (body && typeof body === 'object') {
      const errorCode = (body as { errorCode?: string }).errorCode;
      const message = (body as { message?: string }).message;
      if (errorCode || message) {
        return [errorCode, message].filter(Boolean).join(' — ');
      }
      try {
        return JSON.stringify(body);
      } catch {
        return '[unserialisable error body]';
      }
    }
    return typeof body === 'string' ? body : '';
  }

  private isPartialCloseUnsupported(e: unknown): boolean {
    const status = (e as Error & { status?: number } | null)?.status;
    return status === 400 || status === 422;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ==================== CANDLE CONVERSION ====================

/**
 * Convert a Capital.com OHLC candle (bid/ask pair per price) to our shared
 * Candle shape using the mid-price: (bid + ask) / 2.
 */
export function capitalCandleToCandle(c: CapitalCandle): Candle {
  const mid = (bid: number, ask: number): number => (bid + ask) / 2;
  return {
    datetime: c.snapshotTimeUTC ?? c.snapshotTime,
    open: mid(c.openPrice.bid, c.openPrice.ask),
    high: mid(c.highPrice.bid, c.highPrice.ask),
    low: mid(c.lowPrice.bid, c.lowPrice.ask),
    close: mid(c.closePrice.bid, c.closePrice.ask),
    volume: c.lastTradedVolume ?? 0,
  };
}
