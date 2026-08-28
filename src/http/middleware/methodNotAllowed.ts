import type { Context } from "hono";

export function methodNotAllowed(c: Context) {
  return c.json({ error: "method_not_allowed" }, 405);
}
