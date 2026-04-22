import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { summarizeError } from '../src/scheduler/error-summary.js';

describe('summarizeError', () => {
  it('returns the message for a plain Error', () => {
    expect(summarizeError(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error inputs', () => {
    expect(summarizeError('raw string')).toBe('raw string');
    expect(summarizeError(42)).toBe('42');
    expect(summarizeError(null)).toBe('null');
  });

  it('summarises an ECONNABORTED AxiosError to a single line with method + url', () => {
    const err = new AxiosError(
      'timeout of 15000ms exceeded',
      'ECONNABORTED',
      {
        method: 'get',
        url: '/api/v1/history/activity',
        headers: new AxiosHeaders(),
      },
    );
    expect(summarizeError(err)).toBe(
      'ECONNABORTED timeout on GET /api/v1/history/activity',
    );
  });

  it('summarises an HTTP error response with status + method + url', () => {
    const config = {
      method: 'get',
      url: '/api/v1/positions',
      headers: new AxiosHeaders(),
    };
    const err = new AxiosError('Request failed with status code 500', undefined, config);
    // AxiosError response is assigned separately; set it explicitly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).response = { status: 500, statusText: 'Internal Server Error' };
    expect(summarizeError(err)).toBe(
      'HTTP 500 on GET /api/v1/positions: Request failed with status code 500',
    );
  });

  it('does not leak CST / X-SECURITY-TOKEN / X-CAP-API-KEY headers in the summary', () => {
    // This is the regression test for the 2026-04-22 credential-leak incident.
    // The config below mirrors exactly what the Capital client sends — if any
    // of these token values ever appear in the summariser's output, the fix
    // is broken.
    const headers = new AxiosHeaders({
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      CST: '7HQipSad2VHP1Q6GdrugXX8A',
      'X-SECURITY-TOKEN': 'duJmzYMUfR0QkKjbMokBaBXBAAZ1MXP',
      'X-CAP-API-KEY': 'lUtbwYAOOSKTVbuO',
    });
    const err = new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED', {
      method: 'get',
      url: '/api/v1/history/activity',
      headers,
    });

    const summary = summarizeError(err);

    expect(summary).not.toContain('7HQipSad2VHP1Q6GdrugXX8A');
    expect(summary).not.toContain('duJmzYMUfR0QkKjbMokBaBXBAAZ1MXP');
    expect(summary).not.toContain('lUtbwYAOOSKTVbuO');
    expect(summary).not.toContain('CST');
    expect(summary).not.toContain('X-SECURITY-TOKEN');
    expect(summary).not.toContain('X-CAP-API-KEY');
  });

  it('falls back to a generic axios summary when code is missing and there is no response', () => {
    const err = new AxiosError('Network Error', undefined, {
      method: 'post',
      url: '/api/v1/positions',
      headers: new AxiosHeaders(),
    });
    expect(summarizeError(err)).toBe(
      'AxiosError on POST /api/v1/positions: Network Error',
    );
  });
});
