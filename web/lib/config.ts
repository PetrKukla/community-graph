const API_KEY_STORAGE = 'cg:api-key';

/** Base URL of the API. Empty string in prod (same origin, optionally behind a reverse proxy). */
export const apiBase: string = import.meta.env.VITE_API_BASE ?? '';

function storedApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

/**
 * API key for `x-api-key`. In dev it comes from `VITE_API_KEY` in the root `.env`; a value the
 * user pastes into the UI is kept in localStorage. In prod a reverse proxy injects the header
 * and this is empty.
 */
export function apiKey(): string {
  return import.meta.env.VITE_API_KEY || storedApiKey();
}

export function setApiKey(value: string): void {
  try {
    if (value) localStorage.setItem(API_KEY_STORAGE, value);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    /* private mode / storage disabled - nothing to persist */
  }
}

/** WebSocket URL for the event stream, carrying the API key as `?token=` (WS can't set headers). */
export function streamUrl(): string {
  const base = apiBase || window.location.origin;
  const url = new URL('/api/v1/stream', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const key = apiKey();
  if (key) url.searchParams.set('token', key);
  return url.toString();
}
