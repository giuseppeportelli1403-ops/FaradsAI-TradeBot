// 2026-05-10 Phase-2 migration-drift cleanup, Task P3.1 — guard test for the
// Telegram CRITICAL alert fired when both Capital legs placed but the DB
// write failed (DB_LOG_FAILED_AFTER_PLACEMENT branch in place_split_trade).
//
// Why mock at the telegraf layer rather than mocking the alertOrphanPositions
// export itself: this test verifies the *message text* that lands on Giuseppe's
// phone — including mdEsc behaviour and that both deal IDs survive the format
// step. Mocking the export would only verify the signature, not the wire
// payload, defeating the point of the test.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture every sendMessage call so we can inspect the rendered message body.
const sendMessageMock = vi.fn().mockResolvedValue(undefined);

vi.mock('telegraf', () => ({
  Telegraf: class MockTelegraf {
    telegram = { sendMessage: sendMessageMock };
    constructor(_token: string) {}
  },
}));

describe('alertOrphanPositions (P3.1 — DB_LOG_FAILED_AFTER_PLACEMENT alert)', () => {
  beforeEach(async () => {
    sendMessageMock.mockClear();
    // Telegraf bot only initialises if both env vars are present and non-empty.
    // Set them BEFORE importing telegram.ts so initTelegram() actually wires
    // up the mock. (vi.mock is hoisted, so the import below picks up the mock.)
    process.env.TELEGRAM_BOT_TOKEN = 'mock-token';
    process.env.TELEGRAM_CHAT_ID = 'mock-chat-id';
    const telegram = await import('../src/notifications/telegram.js');
    telegram.initTelegram();
  });

  it('sends a CRITICAL Telegram alert containing both dealIds, instrument, direction, and error', async () => {
    const { alertOrphanPositions } = await import('../src/notifications/telegram.js');
    await alertOrphanPositions({
      instrument: 'OIL_CRUDE',
      direction: 'BUY',
      legA: { dealId: 'DEAL-AAA-111', size: 0.5 },
      legB: { dealId: 'DEAL-BBB-222', size: 0.5 },
      errorMessage: 'SQLITE_BUSY: database is locked',
    });

    // Exactly one Telegram send — no retry, no double-fire.
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    // sendMessage(chatId, text, opts) — the message body is arg index 1.
    const messageText = sendMessageMock.mock.calls[0][1] as string;

    // Headline + reconciliation guidance.
    expect(messageText).toContain('CRITICAL');
    expect(messageText).toContain('ORPHAN POSITIONS');
    expect(messageText).toContain('Manual reconciliation required');

    // Both deal IDs must survive — losing either makes manual reconcile
    // impossible since the bot has no DB row to look them up from.
    expect(messageText).toContain('DEAL-AAA-111');
    expect(messageText).toContain('DEAL-BBB-222');

    // Instrument lands escaped (mdEsc replaces underscore -> \_) so the
    // string `OIL_CRUDE` won't appear verbatim; check the escaped form.
    expect(messageText).toContain('OIL\\_CRUDE');

    // Direction is rendered raw (BUY/SELL has no markdown chars).
    expect(messageText).toContain('BUY');

    // Error message surfaces so Giuseppe knows whether it's a transient
    // SQLITE_BUSY (retry-friendly) or a schema/constraint failure (fix code).
    expect(messageText).toContain('SQLITE\\_BUSY');
    expect(messageText).toContain('database is locked');
  });
});
