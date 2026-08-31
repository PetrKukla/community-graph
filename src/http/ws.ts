import { createBunWebSocket } from 'hono/bun';

/**
 * Shared Bun WebSocket helper for Hono. `upgradeWebSocket` wraps a route handler;
 * `websocket` is handed to `Bun.serve` in src/index.ts so upgrades are actually served.
 */
export const { upgradeWebSocket, websocket } = createBunWebSocket();
