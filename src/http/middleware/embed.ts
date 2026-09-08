import type { MiddlewareHandler } from 'hono';
import { env } from '../../config/env';

/**
 * Lets an approved dashboard embed the web UI in an `<iframe>`. Sets a
 * `frame-ancestors` CSP from `WEB_EMBED_ORIGINS` and drops the legacy
 * `X-Frame-Options` header a proxy might inject. No-op when the list is empty
 * (default: the page can only be framed same-origin).
 */
export const embedHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const origins = env.WEB_EMBED_ORIGINS;
  if (origins.length === 0) return;
  c.res.headers.set(
    'Content-Security-Policy',
    `frame-ancestors 'self' ${origins.join(' ')}`
  );
  c.res.headers.delete('X-Frame-Options');
};
