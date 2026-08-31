import { Hono } from 'hono';
import { config } from '../../config/config';
import { bus } from '../../core/events/bus';
import { computeStatsTick } from '../../db/sqlite/repositories/statsRepository';
import { upgradeWebSocket } from '../ws';

// stats.tick is only computed while at least one client is listening (see WEBAPP.md open Q3).
let clientCount = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;

function emitTick(): void {
  try {
    bus.emit('stats.tick', computeStatsTick());
  } catch (err) {
    console.error(
      `[stats.tick] failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function clientConnected(): void {
  clientCount++;
  if (!tickTimer) {
    tickTimer = setInterval(emitTick, config.web.stats_tick_seconds * 1000);
  }
}

function clientDisconnected(): void {
  clientCount = Math.max(0, clientCount - 1);
  if (clientCount === 0 && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export const streamRoute = new Hono();

// Auth is handled upstream by apiKeyAuth (it accepts ?token= for this route).
streamRoute.get(
  '/stream',
  upgradeWebSocket(() => {
    let unsubscribe: (() => void) | undefined;
    return {
      onOpen(_evt, ws) {
        unsubscribe = bus.onAny((envelope) => {
          try {
            ws.send(JSON.stringify(envelope));
          } catch {
            /* socket already gone - onClose will clean up */
          }
        });
        clientConnected();
        // give the fresh client an immediate snapshot instead of waiting a full tick
        try {
          ws.send(
            JSON.stringify({ event: 'stats.tick', data: computeStatsTick() })
          );
        } catch {
          /* ignore */
        }
      },
      onClose() {
        unsubscribe?.();
        clientDisconnected();
      }
    };
  })
);
