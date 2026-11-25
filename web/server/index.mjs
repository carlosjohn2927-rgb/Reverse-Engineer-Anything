import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApi } from "./api.mjs";
import { loadConfig, reaRuntimeBuilt } from "./config.mjs";
import { framingHeaders, originAllowed, sendError, sendJson } from "./http.mjs";
import { ReaHost } from "./rea-host.mjs";
import { createStaticHandler } from "./static.mjs";

const WEB_ROOT = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(WEB_ROOT, "..", "app");
const DIST_ROOT = join(WEB_ROOT, "..", "dist");

const log = (entry) =>
  process.stderr.write(
    `${JSON.stringify({ time: Date.now(), app: "rea-web", ...entry })}\n`,
  );

const config = loadConfig(process.env);
const host = new ReaHost({ config, log });
const api = createApi({ config, host, log });
// A build in `web/dist` wins; the source tree keeps `npm run dev` working.
const serveStatic = createStaticHandler({
  root: DIST_ROOT,
  fallbackRoot: APP_ROOT,
  config,
});

/** CORS for the preview proxy: reflect the caller's origin when allowed. */
const applyCors = (request, response) => {
  const origin = request.headers.origin;
  if (typeof origin === "string" && originAllowed(origin, request, config)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
    response.setHeader("access-control-allow-credentials", "true");
  }
  response.setHeader(
    "access-control-allow-methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  response.setHeader(
    "access-control-allow-headers",
    "content-type, x-rea-session",
  );
  response.setHeader("access-control-max-age", "600");
};

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  try {
    if (url.pathname.startsWith("/api/")) {
      applyCors(request, response);
      if (request.method === "OPTIONS") {
        response.writeHead(204, framingHeaders(request, config)).end();
        return;
      }
      const origin = request.headers.origin;
      if (
        typeof origin === "string" &&
        !originAllowed(origin, request, config)
      ) {
        sendError(
          response,
          403,
          "origin_rejected",
          "Cross-origin caller rejected.",
        );
        return;
      }
      for (const [name, value] of Object.entries(
        framingHeaders(request, config),
      ))
        response.setHeader(name, value);
      if (!reaRuntimeBuilt(config)) {
        sendError(
          response,
          503,
          "rea_runtime_missing",
          "REA's compiled runtime is missing. Run `npm ci && npm run build:cached` in the repository, then reload.",
        );
        return;
      }
      const handled = await api.handle(request, response, url);
      if (!handled)
        sendError(response, 404, "not_found", `No route for ${url.pathname}.`);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendError(
        response,
        405,
        "method_not_allowed",
        "Static files are read-only.",
      );
      return;
    }
    await serveStatic(request, response, url.pathname);
  } catch (error) {
    log({
      event: "request-failed",
      path: url.pathname,
      message: String(error),
    });
    if (!response.headersSent)
      sendError(
        response,
        500,
        "internal_error",
        error instanceof Error ? error.message : String(error),
      );
    else response.end();
  }
});

host.startReaper();

server.listen(config.port, config.host, () => {
  const runtime = host.nodeExecutable ?? process.execPath;
  log({
    event: "listening",
    host: config.host,
    port: config.port,
    reaBuilt: reaRuntimeBuilt(config),
    runtime,
    servedFrom: existsSync(join(DIST_ROOT, "index.html")) ? "dist" : "app",
  });
  process.stdout.write(
    `\n  REA web workspace\n  http://localhost:${config.port}/\n\n`,
  );
});

const shutdown = async (signal) => {
  log({ event: "shutdown", signal });
  server.close();
  await host.shutdown().catch(() => undefined);
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

export { server, sendJson };
