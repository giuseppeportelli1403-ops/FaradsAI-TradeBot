import { describe, it, expect } from 'vitest';

describe('telegram module', () => {
  it('imports without error', async () => {
    const mod = await import('../src/notifications/telegram.js');
    expect(mod).toBeDefined();
  });

  it('initTelegram is a function', async () => {
    const { initTelegram } = await import('../src/notifications/telegram.js');
    expect(typeof initTelegram).toBe('function');
  });

  it('alertTradePlaced is a function', async () => {
    const { alertTradePlaced } = await import('../src/notifications/telegram.js');
    expect(typeof alertTradePlaced).toBe('function');
  });

  it('alertKillSwitch is a function', async () => {
    const { alertKillSwitch } = await import('../src/notifications/telegram.js');
    expect(typeof alertKillSwitch).toBe('function');
  });

  it('alertWeeklyReport is a function', async () => {
    const { alertWeeklyReport } = await import('../src/notifications/telegram.js');
    expect(typeof alertWeeklyReport).toBe('function');
  });
});
