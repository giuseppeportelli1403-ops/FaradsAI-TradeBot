// Sanitised one-line summariser for errors that might be AxiosErrors.
//
// Motivating incident — 2026-04-22 07:25:15 UTC: a Capital.com
// `/api/v1/history/activity` call timed out, and the monitor loop's
// `console.error('...', axiosError)` triggered util.inspect on the raw
// AxiosError. That expanded into ~60 lines including the full axios
// `config` block — which for authenticated Capital requests contains the
// live CST, X-SECURITY-TOKEN, and X-CAP-API-KEY headers. Those credentials
// ended up in pm2-err.log on disk.
//
// This helper keeps the operational signal (what HTTP call failed, why)
// but strips the headers/body/request-chain entirely. Safe to pass any
// unknown value — falls through to the underlying Error message or
// String(x) for non-axios paths.

import axios from 'axios';

export function summarizeError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const method = err.config?.method?.toUpperCase() ?? '?';
    const url = err.config?.url ?? '?';
    if (err.code === 'ECONNABORTED') {
      return `ECONNABORTED timeout on ${method} ${url}`;
    }
    if (err.response) {
      return `HTTP ${err.response.status} on ${method} ${url}: ${err.message}`;
    }
    const code = err.code ?? 'AxiosError';
    return `${code} on ${method} ${url}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
