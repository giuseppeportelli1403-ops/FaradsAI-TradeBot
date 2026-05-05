// Capital.com REST API Client — unit tests
//
// Strategy: mock axios at the module level. CapitalClient creates an instance
// via axios.create(...) and drives all traffic through instance.request(...).
// We return a fake instance whose .request() is a programmable vi.fn(), then
// queue responses per test case via mockResponses().
//
// Covered scenarios (per migration plan):
//   - session creation success → CST + X-SECURITY-TOKEN stored
//   - session re-auth on 401 → retries once with 50ms backoff
//   - ping after 9 minutes idle refreshes session
//   - openPosition → polls /confirms/:dealReference → returns DealConfirmation
//   - deal rejection → throws CapitalDealError
//   - partialClosePosition happy path (DELETE with size body)
//   - partialClosePosition fallback (DELETE 400/422 → close + reopen preserving SL/TP/trailing)
//   - logout clears tokens

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- axios module mock ----
// Returns a module-level shape matching what CapitalClient imports:
//   `import axios from 'axios'` + `axios.create({ ... })`
// Every test gets a fresh requestMock via resetAxiosMock() below.
let requestMock: ReturnType<typeof vi.fn>;

vi.mock('axios', () => {
  const instance = {
    request: (...args: unknown[]) => requestMock(...args),
  };
  const axios = {
    create: vi.fn(() => instance),
  };
  return { default: axios, ...axios };
});

// Imported AFTER the mock is registered.
import {
  CapitalClient,
  CapitalAuthError,
  CapitalDealError,
} from '../src/mcp-server/capital-client.js';

// ==================== HELPERS ====================

type FakeRes = {
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
};

/** Build a basic 200 session-create response with CST + XST headers. */
function sessionOkResponse(overrides?: Partial<FakeRes>): FakeRes {
  return {
    status: 200,
    data: { accountType: 'DEMO' },
    headers: {
      cst: 'CST-TOKEN-abc',
      'x-security-token': 'XST-TOKEN-xyz',
    },
    ...overrides,
  };
}

function okJson(data: unknown): FakeRes {
  return { status: 200, data, headers: {} };
}

function resetAxiosMock(): void {
  requestMock = vi.fn();
}

function makeClient(): CapitalClient {
  return new CapitalClient({
    apiKey: 'test-api-key',
    identifier: 'user@example.com',
    password: 'hunter2',
    baseURL: 'https://demo-api-capital.backend-capital.com',
  });
}

// ==================== TESTS ====================

describe('CapitalClient — session creation', () => {
  beforeEach(() => {
    resetAxiosMock();
  });

  it('creates a session on first request and stores CST + X-SECURITY-TOKEN', async () => {
    // Sequence:
    //   1) POST /api/v1/session → 200 with CST/XST headers
    //   2) GET  /api/v1/accounts → 200 { accounts: [...] }
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ accounts: [{ accountId: 'A1', accountType: 'DEMO' }] }));

    const client = makeClient();
    const accounts = await client.getAccounts();

    expect(accounts).toHaveLength(1);
    expect(accounts[0].accountId).toBe('A1');

    // Verify the first call is POST /api/v1/session with the right body + API key header.
    const firstCall = requestMock.mock.calls[0][0];
    expect(firstCall.method).toBe('POST');
    expect(firstCall.url).toBe('/api/v1/session');
    expect(firstCall.headers['X-CAP-API-KEY']).toBe('test-api-key');
    expect(firstCall.data).toEqual({
      identifier: 'user@example.com',
      password: 'hunter2',
      encryptedPassword: false,
    });

    // Verify the second call carries the tokens we stored from the session response.
    const secondCall = requestMock.mock.calls[1][0];
    expect(secondCall.method).toBe('GET');
    expect(secondCall.url).toBe('/api/v1/accounts');
    expect(secondCall.headers.CST).toBe('CST-TOKEN-abc');
    expect(secondCall.headers['X-SECURITY-TOKEN']).toBe('XST-TOKEN-xyz');
  });

  it('throws CapitalAuthError if session response omits CST/XST headers', async () => {
    requestMock.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });

    const client = makeClient();
    await expect(client.getAccounts()).rejects.toBeInstanceOf(CapitalAuthError);
  });

  it('throws CapitalAuthError on non-200 session response', async () => {
    requestMock.mockResolvedValueOnce({
      status: 401,
      data: { errorCode: 'error.invalid.details' },
      headers: {},
    });

    const client = makeClient();
    await expect(client.getAccounts()).rejects.toBeInstanceOf(CapitalAuthError);
  });
});

describe('CapitalClient — 401 re-auth retry', () => {
  beforeEach(() => {
    resetAxiosMock();
  });

  it('clears tokens, creates a fresh session, and retries once when a request returns 401', async () => {
    // Sequence:
    //   1) POST /api/v1/session   → 200 (first session)
    //   2) GET  /api/v1/accounts  → 401 (stale!)
    //   3) POST /api/v1/session   → 200 (re-auth)
    //   4) GET  /api/v1/accounts  → 200 ok
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce({ status: 401, data: { errorCode: 'expired' }, headers: {} })
      .mockResolvedValueOnce(
        sessionOkResponse({
          headers: { cst: 'CST-NEW', 'x-security-token': 'XST-NEW' },
        }),
      )
      .mockResolvedValueOnce(okJson({ accounts: [{ accountId: 'A1', accountType: 'DEMO' }] }));

    const client = makeClient();
    const accounts = await client.getAccounts();

    expect(accounts).toHaveLength(1);
    // 4 requests in total: 2 session creates + 2 accounts attempts
    expect(requestMock).toHaveBeenCalledTimes(4);

    // Final accounts call should carry the NEW tokens.
    const finalCall = requestMock.mock.calls[3][0];
    expect(finalCall.headers.CST).toBe('CST-NEW');
    expect(finalCall.headers['X-SECURITY-TOKEN']).toBe('XST-NEW');
  });

  it('throws CapitalAuthError when retry after re-auth also returns 401', async () => {
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce({ status: 401, data: {}, headers: {} })
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce({ status: 401, data: {}, headers: {} });

    const client = makeClient();
    await expect(client.getAccounts()).rejects.toBeInstanceOf(CapitalAuthError);
  });
});

describe('CapitalClient — ping keep-alive after 9 minutes idle', () => {
  beforeEach(() => {
    resetAxiosMock();
    vi.useRealTimers();
  });

  it("calls /api/v1/ping before the next request when lastActivity is > 9 minutes old", async () => {
    // 1) session create
    // 2) first accounts fetch (establishes lastActivityAt)
    // 3) ping (triggered because idle > 9min)
    // 4) second accounts fetch
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ accounts: [{ accountId: 'A1' }] }))
      .mockResolvedValueOnce(okJson({})) // ping
      .mockResolvedValueOnce(okJson({ accounts: [{ accountId: 'A1' }] }));

    const client = makeClient();
    await client.getAccounts();

    // Fast-forward Date.now() by 10 minutes to simulate idle time.
    const realNow = Date.now;
    const tenMinLater = realNow() + 10 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(tenMinLater);

    await client.getAccounts();

    // Verify the third call was a ping.
    const thirdCall = requestMock.mock.calls[2][0];
    expect(thirdCall.method).toBe('GET');
    expect(thirdCall.url).toBe('/api/v1/ping');
    // And the fourth is the follow-up accounts call.
    const fourthCall = requestMock.mock.calls[3][0];
    expect(fourthCall.url).toBe('/api/v1/accounts');

    vi.restoreAllMocks();
  });

  it('re-creates a session if the ping after 9min idle itself fails', async () => {
    // 1) session create
    // 2) first accounts (sets lastActivity)
    // 3) ping → 500 (fails)
    // 4) new session create
    // 5) second accounts → 200
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ accounts: [] }))
      .mockResolvedValueOnce({ status: 500, data: {}, headers: {} })
      .mockResolvedValueOnce(
        sessionOkResponse({ headers: { cst: 'CST-2', 'x-security-token': 'XST-2' } }),
      )
      .mockResolvedValueOnce(okJson({ accounts: [{ accountId: 'A2' }] }));

    const client = makeClient();
    await client.getAccounts();

    const later = Date.now() + 10 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);

    const accounts = await client.getAccounts();
    expect(accounts[0].accountId).toBe('A2');

    // Verify a 4th call was a fresh session create.
    const fourthCall = requestMock.mock.calls[3][0];
    expect(fourthCall.method).toBe('POST');
    expect(fourthCall.url).toBe('/api/v1/session');

    vi.restoreAllMocks();
  });
});

describe('CapitalClient — openPosition deal confirmation polling', () => {
  beforeEach(() => {
    resetAxiosMock();
  });

  it('polls /confirms/:ref and returns the DealConfirmation on ACCEPTED', async () => {
    // 1) session
    // 2) POST /positions → { dealReference: 'REF-1' }
    // 3) GET /confirms/REF-1 → ACCEPTED
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ dealReference: 'REF-1' }))
      .mockResolvedValueOnce(
        okJson({
          dealId: 'DEAL-123',
          dealReference: 'REF-1',
          dealStatus: 'ACCEPTED',
          reason: 'SUCCESS',
          status: 'OPEN',
          direction: 'BUY',
          epic: 'US100',
          size: 1,
          level: 15000,
          stopLevel: 14950,
          profitLevel: 15100,
          affectedDeals: [],
        }),
      );

    const client = makeClient();
    const confirmation = await client.openPosition({
      direction: 'BUY',
      epic: 'US100',
      size: 1,
      stopLevel: 14950,
      profitLevel: 15100,
    });

    expect(confirmation.dealStatus).toBe('ACCEPTED');
    expect(confirmation.dealId).toBe('DEAL-123');

    // Verify POST /positions carried the params as JSON body.
    const postCall = requestMock.mock.calls[1][0];
    expect(postCall.method).toBe('POST');
    expect(postCall.url).toBe('/api/v1/positions');
    expect(postCall.data).toEqual({
      direction: 'BUY',
      epic: 'US100',
      size: 1,
      stopLevel: 14950,
      profitLevel: 15100,
    });

    // Verify the confirms lookup.
    const confirmCall = requestMock.mock.calls[2][0];
    expect(confirmCall.method).toBe('GET');
    expect(confirmCall.url).toBe('/api/v1/confirms/REF-1');
  });

  it('overrides top-level dealId with affectedDeals[0].dealId when affectedDeals is non-empty (fixes workingOrderId-vs-positionDealId bug)', async () => {
    // This mirrors the exact shape captured live from Capital.com:
    //   - top-level dealId is actually the workingOrderId
    //   - affectedDeals[0].dealId is the real position dealId
    // After the fix, the returned confirmation.dealId must be the position one.
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ dealReference: 'o_910f02e5' }))
      .mockResolvedValueOnce(
        okJson({
          dealId: '00005552-0000-0000-0000-00000000-9fca', // workingOrderId
          dealReference: 'o_910f02e5',
          dealStatus: 'ACCEPTED',
          reason: 'SUCCESS',
          status: 'OPEN',
          direction: 'BUY',
          epic: 'EURUSD',
          size: 1,
          level: 1.085,
          stopLevel: 1.08,
          profitLevel: 1.09,
          affectedDeals: [
            {
              dealId: '00005552-0000-0000-0000-00000000-9fcb', // real position dealId
              status: 'OPENED',
            },
          ],
        }),
      );

    const client = makeClient();
    const confirmation = await client.openPosition({
      direction: 'BUY',
      epic: 'EURUSD',
      size: 1,
      stopLevel: 1.08,
      profitLevel: 1.09,
    });

    // dealId must be the position dealId from affectedDeals, NOT the top-level workingOrderId.
    expect(confirmation.dealId).toBe('00005552-0000-0000-0000-00000000-9fcb');
    // All other fields preserved unchanged.
    expect(confirmation.dealStatus).toBe('ACCEPTED');
    expect(confirmation.status).toBe('OPEN');
    expect(confirmation.reason).toBe('SUCCESS');
    expect(confirmation.direction).toBe('BUY');
    expect(confirmation.epic).toBe('EURUSD');
    expect(confirmation.size).toBe(1);
    expect(confirmation.level).toBe(1.085);
    expect(confirmation.stopLevel).toBe(1.08);
    expect(confirmation.profitLevel).toBe(1.09);
    expect(confirmation.dealReference).toBe('o_910f02e5');
    expect(confirmation.affectedDeals).toEqual([
      { dealId: '00005552-0000-0000-0000-00000000-9fcb', status: 'OPENED' },
    ]);
  });

  it('falls back to top-level dealId when affectedDeals is empty', async () => {
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ dealReference: 'REF-EMPTY' }))
      .mockResolvedValueOnce(
        okJson({
          dealId: 'TOP-LEVEL-ID',
          dealReference: 'REF-EMPTY',
          dealStatus: 'ACCEPTED',
          reason: 'SUCCESS',
          status: 'OPEN',
          direction: 'BUY',
          epic: 'US100',
          size: 1,
          level: 15000,
          stopLevel: null,
          profitLevel: null,
          affectedDeals: [], // explicit empty
        }),
      );

    const client = makeClient();
    const confirmation = await client.openPosition({
      direction: 'BUY',
      epic: 'US100',
      size: 1,
    });

    expect(confirmation.dealId).toBe('TOP-LEVEL-ID');
    expect(confirmation.dealStatus).toBe('ACCEPTED');
  });

  it('falls back to top-level dealId when affectedDeals is missing entirely (undefined)', async () => {
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ dealReference: 'REF-MISSING' }))
      .mockResolvedValueOnce(
        okJson({
          dealId: 'TOP-ONLY-ID',
          dealReference: 'REF-MISSING',
          dealStatus: 'ACCEPTED',
          reason: 'SUCCESS',
          status: 'OPEN',
          direction: 'SELL',
          epic: 'GOLD',
          size: 0.5,
          level: 2400,
          stopLevel: null,
          profitLevel: null,
          // affectedDeals omitted from the response entirely
        }),
      );

    const client = makeClient();
    const confirmation = await client.openPosition({
      direction: 'SELL',
      epic: 'GOLD',
      size: 0.5,
    });

    expect(confirmation.dealId).toBe('TOP-ONLY-ID');
    expect(confirmation.direction).toBe('SELL');
    expect(confirmation.epic).toBe('GOLD');
    expect(confirmation.size).toBe(0.5);
    expect(confirmation.level).toBe(2400);
  });

  // 2026-05-05 audit (5.2 + Codex follow-up): when Capital returns multiple
  // affectedDeals with mixed statuses, pick the first OPEN/OPENED/ACCEPTED/
  // AMENDED/PARTIALLY_CLOSED entry, not [0]. The previous test fixture only
  // had a single OPENED entry; this regression test covers the multi-status
  // case Codex flagged.
  it('selects the first acceptable-status affectedDeal when [0] is DELETED', async () => {
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ dealReference: 'o_multi_status' }))
      .mockResolvedValueOnce(
        okJson({
          dealId: 'WORKING-ORDER-ID',
          dealReference: 'o_multi_status',
          dealStatus: 'ACCEPTED',
          reason: 'SUCCESS',
          status: 'OPEN',
          direction: 'BUY',
          epic: 'EURUSD',
          size: 1,
          level: 1.085,
          stopLevel: 1.08,
          profitLevel: 1.09,
          affectedDeals: [
            { dealId: 'STALE-DELETED-ID', status: 'DELETED' },
            { dealId: 'LIVE-OPENED-ID', status: 'OPENED' },
          ],
        }),
      );

    const client = makeClient();
    const confirmation = await client.openPosition({
      direction: 'BUY',
      epic: 'EURUSD',
      size: 1,
      stopLevel: 1.08,
      profitLevel: 1.09,
    });

    // Pre-fix this would have returned STALE-DELETED-ID (the first entry).
    expect(confirmation.dealId).toBe('LIVE-OPENED-ID');
  });

  it('createWorkingOrder preserves workingOrderId as dealId when affectedDeals is empty (fallback path)', async () => {
    // Working-order creation returns a confirmation whose top-level dealId IS
    // the workingOrderId (correct — it's what updateWorkingOrder /
    // deleteWorkingOrder need to reference the pending order). Capital sends
    // affectedDeals: [] at this stage because no position exists yet; the
    // order only opens a position later on fill. The fix's fallback MUST
    // preserve the workingOrderId here, otherwise update/delete break.
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ dealReference: 'o_wo_abcdef' }))
      .mockResolvedValueOnce(
        okJson({
          dealId: 'WORKING-ORDER-ID-42',
          dealReference: 'o_wo_abcdef',
          dealStatus: 'ACCEPTED',
          reason: 'SUCCESS',
          status: 'OPEN',
          direction: 'BUY',
          epic: 'EURUSD',
          size: 1,
          level: 1.08,
          stopLevel: 1.07,
          profitLevel: 1.1,
          affectedDeals: [],
        }),
      );

    const client = makeClient();
    const confirmation = await client.createWorkingOrder({
      direction: 'BUY',
      epic: 'EURUSD',
      size: 1,
      level: 1.08,
      type: 'LIMIT',
      stopLevel: 1.07,
      profitLevel: 1.1,
    });

    expect(confirmation.dealId).toBe('WORKING-ORDER-ID-42');
    expect(confirmation.dealStatus).toBe('ACCEPTED');
    expect(confirmation.affectedDeals).toEqual([]);
  });

  it('normaliseDealId is pure — returned object is a distinct reference from the raw /confirms response', async () => {
    // Locks the pure-function contract: the fix must never mutate the raw
    // Capital response. A spread-and-override was chosen precisely to avoid
    // sharing reference identity with the input. If a future refactor ever
    // switches to in-place mutation, this test catches it.
    const rawConfirmPayload = {
      dealId: 'TOP-LEVEL-WORKING-ORDER-ID',
      dealReference: 'o_purity_test',
      dealStatus: 'ACCEPTED' as const,
      reason: 'SUCCESS',
      status: 'OPEN' as const,
      direction: 'BUY' as const,
      epic: 'EURUSD',
      size: 1,
      level: 1.18,
      stopLevel: null,
      profitLevel: null,
      affectedDeals: [{ dealId: 'REAL-POSITION-ID', status: 'OPENED' }],
    };

    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ dealReference: 'o_purity_test' }))
      .mockResolvedValueOnce(okJson(rawConfirmPayload));

    const client = makeClient();
    const confirmation = await client.openPosition({
      direction: 'BUY',
      epic: 'EURUSD',
      size: 1,
    });

    // The returned object must be a distinct reference so callers cannot
    // inadvertently mutate what appears to be "the response" and affect
    // other consumers of the same payload.
    expect(confirmation).not.toBe(rawConfirmPayload);
    // But the raw payload itself must remain untouched (no side-effects).
    expect(rawConfirmPayload.dealId).toBe('TOP-LEVEL-WORKING-ORDER-ID');
    // And the override did happen on the returned copy.
    expect(confirmation.dealId).toBe('REAL-POSITION-ID');
  });

  it('throws CapitalDealError when Capital returns dealStatus REJECTED', async () => {
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ dealReference: 'REF-BAD' }))
      .mockResolvedValueOnce(
        okJson({
          dealId: '',
          dealReference: 'REF-BAD',
          dealStatus: 'REJECTED',
          reason: 'INSUFFICIENT_FUNDS',
          status: 'DELETED',
          direction: 'BUY',
          epic: 'US100',
          size: 1,
          level: 0,
          stopLevel: null,
          profitLevel: null,
          affectedDeals: [],
        }),
      );

    const client = makeClient();
    await expect(
      client.openPosition({ direction: 'BUY', epic: 'US100', size: 1 }),
    ).rejects.toBeInstanceOf(CapitalDealError);
  });
});

describe('CapitalClient — partialClosePosition', () => {
  beforeEach(() => {
    resetAxiosMock();
  });

  it('happy path: DELETE /positions/:id with { size } body succeeds', async () => {
    // 1) session
    // 2) DELETE /positions/DEAL-1 → { dealReference: 'REF-PC' }
    // 3) GET /confirms/REF-PC → ACCEPTED
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ dealReference: 'REF-PC' }))
      .mockResolvedValueOnce(
        okJson({
          dealId: 'DEAL-1',
          dealReference: 'REF-PC',
          dealStatus: 'ACCEPTED',
          reason: 'SUCCESS',
          status: 'PARTIALLY_CLOSED',
          direction: 'BUY',
          epic: 'US100',
          size: 0.5,
          level: 15000,
          stopLevel: null,
          profitLevel: null,
          affectedDeals: [],
        }),
      );

    const client = makeClient();
    const confirmation = await client.partialClosePosition('DEAL-1', 0.5);

    expect(confirmation.dealStatus).toBe('ACCEPTED');
    expect(confirmation.status).toBe('PARTIALLY_CLOSED');

    const deleteCall = requestMock.mock.calls[1][0];
    expect(deleteCall.method).toBe('DELETE');
    expect(deleteCall.url).toBe('/api/v1/positions/DEAL-1');
    expect(deleteCall.data).toEqual({ size: 0.5 });
  });

  it('fallback: on 400 falls back to full-close then reopen, preserving SL/TP', async () => {
    // 1) session
    // 2) DELETE /positions/DEAL-1 with {size:0.5} → 400 (partial unsupported)
    // 3) GET /positions/DEAL-1 → position metadata (size=1, SL=14950, TP=15100)
    // 4) DELETE /positions/DEAL-1 → { dealReference: 'REF-FULL' } (full close)
    // 5) GET /confirms/REF-FULL → ACCEPTED
    // 6) POST /positions (reopen 0.5 remaining with same SL/TP) → { dealReference: 'REF-REO' }
    // 7) GET /confirms/REF-REO → ACCEPTED
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      // Partial DELETE → 400 (unsupported)
      .mockResolvedValueOnce({
        status: 400,
        data: { errorCode: 'partial.close.unsupported' },
        headers: {},
      })
      // getPosition
      .mockResolvedValueOnce(
        okJson({
          position: {
            dealId: 'DEAL-1',
            dealReference: 'REF-ORIG',
            direction: 'BUY',
            size: 1,
            openLevel: 15000,
            stopLevel: 14950,
            profitLevel: 15100,
            trailingStop: false,
            trailingStopDistance: null,
            guaranteedStop: false,
            createdDateUTC: '2026-04-17T09:00:00Z',
            controlledRisk: false,
          },
          market: {
            instrumentName: 'Nasdaq 100',
            epic: 'US100',
            bid: 15000,
            offer: 15001,
            marketStatus: 'TRADEABLE',
          },
        }),
      )
      // Full DELETE → dealReference
      .mockResolvedValueOnce(okJson({ dealReference: 'REF-FULL' }))
      // /confirms for the full close
      .mockResolvedValueOnce(
        okJson({
          dealId: 'DEAL-1',
          dealReference: 'REF-FULL',
          dealStatus: 'ACCEPTED',
          reason: 'SUCCESS',
          status: 'FULLY_CLOSED',
          direction: 'BUY',
          epic: 'US100',
          size: 1,
          level: 15000,
          stopLevel: null,
          profitLevel: null,
          affectedDeals: [],
        }),
      )
      // POST reopen
      .mockResolvedValueOnce(okJson({ dealReference: 'REF-REO' }))
      // /confirms for reopen
      .mockResolvedValueOnce(
        okJson({
          dealId: 'DEAL-2',
          dealReference: 'REF-REO',
          dealStatus: 'ACCEPTED',
          reason: 'SUCCESS',
          status: 'OPEN',
          direction: 'BUY',
          epic: 'US100',
          size: 0.5,
          level: 15000,
          stopLevel: 14950,
          profitLevel: 15100,
          affectedDeals: [],
        }),
      );

    const client = makeClient();
    const confirmation = await client.partialClosePosition('DEAL-1', 0.5);

    expect(confirmation.dealId).toBe('DEAL-2');
    expect(confirmation.size).toBe(0.5);

    // The reopen POST should preserve stopLevel + profitLevel.
    const reopenCall = requestMock.mock.calls[5][0];
    expect(reopenCall.method).toBe('POST');
    expect(reopenCall.url).toBe('/api/v1/positions');
    expect(reopenCall.data).toMatchObject({
      direction: 'BUY',
      epic: 'US100',
      size: 0.5,
      stopLevel: 14950,
      profitLevel: 15100,
    });
  });

  it('fallback: preserves trailingStop + trailingStopDistance on reopen', async () => {
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce({
        status: 422,
        data: { errorCode: 'partial.close.unsupported' },
        headers: {},
      })
      .mockResolvedValueOnce(
        okJson({
          position: {
            dealId: 'DEAL-1',
            dealReference: 'REF-ORIG',
            direction: 'SELL',
            size: 2,
            openLevel: 15000,
            stopLevel: null,
            profitLevel: null,
            trailingStop: true,
            trailingStopDistance: 50,
            guaranteedStop: false,
            createdDateUTC: '2026-04-17T09:00:00Z',
            controlledRisk: false,
          },
          market: {
            instrumentName: 'Nasdaq 100',
            epic: 'US100',
            bid: 15000,
            offer: 15001,
            marketStatus: 'TRADEABLE',
          },
        }),
      )
      .mockResolvedValueOnce(okJson({ dealReference: 'REF-FULL' }))
      .mockResolvedValueOnce(
        okJson({
          dealId: 'DEAL-1',
          dealReference: 'REF-FULL',
          dealStatus: 'ACCEPTED',
          reason: 'SUCCESS',
          status: 'FULLY_CLOSED',
          direction: 'SELL',
          epic: 'US100',
          size: 2,
          level: 15000,
          stopLevel: null,
          profitLevel: null,
          affectedDeals: [],
        }),
      )
      .mockResolvedValueOnce(okJson({ dealReference: 'REF-REO' }))
      .mockResolvedValueOnce(
        okJson({
          dealId: 'DEAL-2',
          dealReference: 'REF-REO',
          dealStatus: 'ACCEPTED',
          reason: 'SUCCESS',
          status: 'OPEN',
          direction: 'SELL',
          epic: 'US100',
          size: 1,
          level: 15000,
          stopLevel: null,
          profitLevel: null,
          affectedDeals: [],
        }),
      );

    const client = makeClient();
    await client.partialClosePosition('DEAL-1', 1);

    const reopenCall = requestMock.mock.calls[5][0];
    expect(reopenCall.data).toMatchObject({
      direction: 'SELL',
      epic: 'US100',
      size: 1,
      trailingStop: true,
      stopDistance: 50,
    });
  });
});

describe('CapitalClient — logout', () => {
  beforeEach(() => {
    resetAxiosMock();
  });

  it('clears tokens so the next request triggers a fresh session create', async () => {
    requestMock
      // 1) session
      .mockResolvedValueOnce(sessionOkResponse())
      // 2) getAccounts (warm)
      .mockResolvedValueOnce(okJson({ accounts: [] }))
      // 3) logout DELETE /session
      .mockResolvedValueOnce(okJson({}))
      // 4) NEW session on post-logout request
      .mockResolvedValueOnce(
        sessionOkResponse({ headers: { cst: 'CST-3', 'x-security-token': 'XST-3' } }),
      )
      // 5) getAccounts with new tokens
      .mockResolvedValueOnce(okJson({ accounts: [{ accountId: 'AX' }] }));

    const client = makeClient();
    await client.getAccounts();
    await client.logout();

    // After logout, the client should re-create a session on next request.
    await client.getAccounts();

    // The call at index 3 must be a fresh POST /api/v1/session
    const fourthCall = requestMock.mock.calls[3][0];
    expect(fourthCall.method).toBe('POST');
    expect(fourthCall.url).toBe('/api/v1/session');

    // And the call at index 4 should carry the NEW tokens.
    const fifthCall = requestMock.mock.calls[4][0];
    expect(fifthCall.headers.CST).toBe('CST-3');
    expect(fifthCall.headers['X-SECURITY-TOKEN']).toBe('XST-3');
  });

  it('is a no-op when called without an active session', async () => {
    const client = makeClient();
    // No requests queued; logout should return without throwing or calling axios.
    await expect(client.logout()).resolves.toBeUndefined();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('swallows errors during logout (shutdown path must not throw)', async () => {
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ accounts: [] }))
      // Logout DELETE → network error
      .mockRejectedValueOnce(new Error('network down'));

    const client = makeClient();
    await client.getAccounts();
    await expect(client.logout()).resolves.toBeUndefined();
  });
});

describe('CapitalClient — createWorkingOrder with P1 expiry + label fields', () => {
  beforeEach(() => {
    resetAxiosMock();
  });

  it('forwards timeInForce, goodTillDate, guaranteedStop, label in request body', async () => {
    // P1 extends CreateWorkingOrderParams with four optional fields so
    // callers (the place_order MCP tool) can express 15-min auto-expiry
    // via Capital's GOOD_TILL_DATE mechanism. The client forwards params
    // verbatim as the POST body — this test locks the pass-through.
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ dealReference: 'P1-REF-1' }))
      .mockResolvedValueOnce(
        okJson({
          dealId: 'WO-P1-1',
          dealReference: 'P1-REF-1',
          dealStatus: 'ACCEPTED',
          reason: 'SUCCESS',
          status: 'OPEN',
          direction: 'BUY',
          epic: 'EURUSD',
          size: 1000,
          level: 1.08523,
          stopLevel: 1.08400,
          profitLevel: 1.08800,
          affectedDeals: [],
        }),
      );

    const client = makeClient();
    await client.createWorkingOrder({
      direction: 'BUY',
      epic: 'EURUSD',
      size: 1000,
      level: 1.08523,
      type: 'LIMIT',
      stopLevel: 1.08400,
      profitLevel: 1.08800,
      timeInForce: 'GOOD_TILL_DATE',
      goodTillDate: '2026-04-24T18:45:00',
      guaranteedStop: false,
      label: 'ICT-EURUSD-A-1776962007',
    });

    // Call 0 = session create, Call 1 = POST /workingorders, Call 2 = /confirms poll.
    // We assert the POST body at call index 1.
    const postCall = requestMock.mock.calls[1][0];
    expect(postCall.method).toBe('POST');
    expect(postCall.url).toBe('/api/v1/workingorders');
    expect(postCall.data).toEqual({
      direction: 'BUY',
      epic: 'EURUSD',
      size: 1000,
      level: 1.08523,
      type: 'LIMIT',
      stopLevel: 1.08400,
      profitLevel: 1.08800,
      timeInForce: 'GOOD_TILL_DATE',
      goodTillDate: '2026-04-24T18:45:00',
      guaranteedStop: false,
      label: 'ICT-EURUSD-A-1776962007',
    });
  });

  it('still accepts the legacy minimal param set (backward compatible)', async () => {
    // Pre-P1 callers passed only {direction, epic, size, level, type,
    // stopLevel?, profitLevel?}. The new optional fields must NOT break
    // them — omitting timeInForce / goodTillDate / guaranteedStop /
    // label should produce a POST body without those keys.
    requestMock
      .mockResolvedValueOnce(sessionOkResponse())
      .mockResolvedValueOnce(okJson({ dealReference: 'LEGACY-REF' }))
      .mockResolvedValueOnce(
        okJson({
          dealId: 'WO-LEGACY',
          dealReference: 'LEGACY-REF',
          dealStatus: 'ACCEPTED',
          reason: 'SUCCESS',
          status: 'OPEN',
          direction: 'BUY',
          epic: 'GBPUSD',
          size: 500,
          level: 1.27,
          stopLevel: null,
          profitLevel: null,
          affectedDeals: [],
        }),
      );

    const client = makeClient();
    await client.createWorkingOrder({
      direction: 'BUY',
      epic: 'GBPUSD',
      size: 500,
      level: 1.27,
      type: 'LIMIT',
    });

    const postCall = requestMock.mock.calls[1][0];
    expect(postCall.data.timeInForce).toBeUndefined();
    expect(postCall.data.goodTillDate).toBeUndefined();
    expect(postCall.data.guaranteedStop).toBeUndefined();
    expect(postCall.data.label).toBeUndefined();
  });
});
