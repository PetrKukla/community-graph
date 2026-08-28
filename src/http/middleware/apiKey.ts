import type { MiddlewareHandler } from "hono";
import { env } from "../../config/env";

export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  const provided = c.req.header("X-API-Key");
  if (provided !== env.API_KEY) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};
