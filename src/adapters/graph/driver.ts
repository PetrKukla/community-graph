import neo4j, { type Driver } from "neo4j-driver";
import { env } from "../../config/env";

let driver: Driver | null = null;

/** Lazily-created shared Neo4j driver. Throws if NEO4J_PASSWORD is not set. */
export function getNeo4jDriver(): Driver {
  if (!env.NEO4J_PASSWORD) {
    throw new Error("Neo4j is not configured - set NEO4J_PASSWORD (and NEO4J_URI / NEO4J_USER) in .env");
  }
  driver ??= neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD), {
    disableLosslessIntegers: true, // return plain JS numbers, not neo4j Integer objects
  });
  return driver;
}

export function isNeo4jConfigured(): boolean {
  return Boolean(env.NEO4J_PASSWORD);
}

export async function closeNeo4jDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
