import { Hono } from "hono";
import { db } from "../../db/sqlite/client";
import { sql } from "drizzle-orm";
import { methodNotAllowed } from "../middleware/methodNotAllowed";

export const healthRoute = new Hono();

healthRoute.get("/health", (c) => {
  try {
    db.run(sql`select 1`);
    return c.json({ status: "ok", sqlite: "ok" });
  } catch (err) {
    return c.json({ status: "error", sqlite: err instanceof Error ? err.message : String(err) }, 503);
  }
});

healthRoute.all("/health", methodNotAllowed);
