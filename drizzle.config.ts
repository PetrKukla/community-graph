import { defineConfig } from 'drizzle-kit';
import { env } from './src/config/env';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/sqlite/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: env.SQLITE_PATH
  }
});
