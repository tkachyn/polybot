/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the API, e.g. "https://polybot-api.fly.dev". Empty = same origin. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
