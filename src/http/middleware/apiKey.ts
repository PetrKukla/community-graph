import type { MiddlewareHandler } from 'hono';
import { env } from '../../config/env';

/**
 * Guards every /api/v1/* route. REST clients send the key as the `X-API-Key` header; the
 * `/stream` WebSocket, whose browser handshake can't set headers, sends it as `?token=`.
 */
export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  const provided = c.req.header('X-API-Key') ?? c.req.query('token');
  if (provided !== env.API_KEY) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};
