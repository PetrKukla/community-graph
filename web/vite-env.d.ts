/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the community-graph API. Dev only; in prod the bundle is same-origin. */
  readonly VITE_API_BASE?: string;
  /** API key sent as x-api-key. Dev only; in prod a reverse proxy injects it. */
  readonly VITE_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
