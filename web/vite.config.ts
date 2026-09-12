/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

const DEFAULT_API_TARGET = "http://127.0.0.1:3001";

function isEventStreamRequest(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/event-stream");
}

/**
 * Proxy for the Fastify API. SSE must pass through unbuffered:
 * - ask the upstream for an uncompressed body (compression buffers chunks),
 * - mark the response `no-transform` / `X-Accel-Buffering: no`,
 * - disable proxy timeouts so long-lived streams are not cut.
 */
function apiProxy(target: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    ws: false,
    timeout: 0,
    proxyTimeout: 0,
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq, req) => {
        if (isEventStreamRequest(req)) {
          proxyReq.setHeader("accept-encoding", "identity");
          proxyReq.setHeader("cache-control", "no-cache");
        }
      });
      proxy.on("proxyRes", (proxyRes) => {
        const type = proxyRes.headers["content-type"];
        if (typeof type === "string" && type.includes("text/event-stream")) {
          proxyRes.headers["cache-control"] = "no-cache, no-transform";
          proxyRes.headers["x-accel-buffering"] = "no";
          delete proxyRes.headers["content-length"];
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // process.env wins; a web/.env(.local) file is a convenience fallback.
  const fileEnv = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_");
  const apiTarget = process.env.VITE_API_TARGET ?? fileEnv.VITE_API_TARGET ?? DEFAULT_API_TARGET;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        // Types-only contract. `import type` erases it; the alias is a safety
        // net so a stray value import resolves to an empty module, not an error.
        "@contract": fileURLToPath(new URL("../src/api/dto.ts", import.meta.url)),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: { "/api": apiProxy(apiTarget) },
    },
    preview: {
      port: 4173,
      proxy: { "/api": apiProxy(apiTarget) },
    },
    build: {
      target: "es2022",
      sourcemap: true,
      // hls.js (~575 kB) is its own chunk, loaded only when a replay opens,
      // so it never weighs on first load. Warn only above that.
      chunkSizeWarningLimit: 700,
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
    },
  };
});
