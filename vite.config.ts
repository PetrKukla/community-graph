import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

const rootDir = import.meta.dirname;

/** Pull a single integer key out of a `[section]` of config.toml without a TOML dependency. */
function tomlInt(section: string, key: string, fallback: number): number {
  try {
    const text = readFileSync(resolve(rootDir, 'config.toml'), 'utf8');
    const body = text.split(/^\[/m).find((s) => s.startsWith(`${section}]`));
    const match = body?.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, 'm'));
    return match ? Number(match[1]) : fallback;
  } catch {
    return fallback;
  }
}

const devPort =
  Number(process.env.VITE_DEV_PORT) || tomlInt('web', 'dev_port', 5173);
const apiPort = Number(process.env.PORT) || tomlInt('server', 'port', 3004);
const apiTarget = process.env.VITE_API_BASE || `http://localhost:${apiPort}`;

// Single Vite project for the whole frontend - no second package.json, no SvelteKit.
// `bun run web:build` emits web/dist/, which the Hono app serves in production.
export default defineConfig({
  root: 'web',
  plugins: [tailwindcss(), svelte({ preprocess: vitePreprocess() })],
  resolve: {
    alias: { $lib: resolve(rootDir, 'web/lib') }
  },
  build: {
    outDir: resolve(rootDir, 'web/dist'),
    emptyOutDir: true
  },
  server: {
    port: devPort,
    // dev only: proxy /api (REST + the /api/v1/stream WebSocket) to the Bun service so the
    // browser stays same-origin and no CORS is involved.
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
        // The /api/v1/stream WebSocket resets (ECONNRESET) every time the Bun API
        // restarts under `bun --watch`, on HMR reloads and on tab close. Vite logs
        // the full stack for each; swap its `error` listener for one that stays
        // quiet on those benign resets but still reports real proxy failures.
        configure(proxy) {
          process.nextTick(() => {
            proxy.removeAllListeners('error');
            proxy.on('error', (err, _req, res) => {
              const code = (err as NodeJS.ErrnoException).code;
              if (code !== 'ECONNRESET' && code !== 'EPIPE') {
                console.error(
                  `[vite] api proxy error: ${err.stack ?? err.message}`
                );
              }
              if (res && 'end' in res && !res.writableEnded) res.end();
            });
          });
        }
      }
    }
  }
});
