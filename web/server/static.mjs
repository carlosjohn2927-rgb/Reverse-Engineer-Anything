import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

import { framingHeaders } from "./http.mjs";

const gzipAsync = promisify(gzip);

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** A built asset name carries a content hash, so it may be cached forever. */
const IMMUTABLE = /\.[0-9a-f]{10}\.(?:js|css|svg|map)$/u;
/** Above this size, compressing per request costs more than it saves. */
const COMPRESS_OVER_BYTES = 1024;

/** Compressed bodies, keyed by path. Bounded so a long uptime cannot grow it. */
const gzipCache = new Map();
const GZIP_CACHE_LIMIT = 64;

const gzipped = async (filePath, stats) => {
  const cached = gzipCache.get(filePath);
  if (cached !== undefined && cached.mtime === stats.mtimeMs) return cached;
  const body = await gzipAsync(await readFile(filePath));
  const entry = { mtime: stats.mtimeMs, body };
  if (gzipCache.size >= GZIP_CACHE_LIMIT && !gzipCache.has(filePath)) {
    const oldest = gzipCache.keys().next().value;
    if (oldest !== undefined) gzipCache.delete(oldest);
  }
  gzipCache.set(filePath, entry);
  return entry;
};

/** A weak validator over size and mtime: enough to answer conditional GETs. */
const etagFor = (stats) =>
  `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;

/**
 * Serve the single-page app, preferring the built output in `web/dist` and
 * falling back to the source tree in `web/app`.
 *
 * Unknown paths without a file extension fall back to `index.html` so client
 * routes survive a reload. Paths are normalized and confined to the root.
 */
export const createStaticHandler = ({ root, fallbackRoot, config }) => {
  const absoluteRoot = resolve(root);
  const absoluteFallback =
    fallbackRoot === undefined ? null : resolve(fallbackRoot);
  return async (request, response, pathname) => {
    const rel = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
    let filePath = resolve(join(absoluteRoot, rel));
    if (filePath !== absoluteRoot && !filePath.startsWith(absoluteRoot + sep)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    let stats;
    try {
      stats = await stat(filePath);
    } catch {
      stats = undefined;
    }
    if (stats?.isDirectory()) {
      filePath = join(filePath, "index.html");
      stats = await stat(filePath).catch(() => undefined);
    }
    if (stats === undefined && absoluteFallback !== null) {
      // The source tree is the fallback when no build has been made yet.
      const candidate = resolve(join(absoluteFallback, rel));
      if (candidate.startsWith(absoluteFallback + sep)) {
        filePath = candidate;
        stats = await stat(filePath).catch(() => undefined);
        if (stats?.isDirectory()) stats = undefined;
      }
    }
    if (stats === undefined && extname(rel) === "") {
      filePath = join(absoluteRoot, "index.html");
      stats = await stat(filePath).catch(() => undefined);
      if (stats === undefined && absoluteFallback !== null) {
        filePath = join(absoluteFallback, "index.html");
        stats = await stat(filePath).catch(() => undefined);
      }
    }
    if (stats === undefined) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const contentType =
      CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
    const cacheControl = IMMUTABLE.test(pathname)
      ? "public, max-age=31536000, immutable"
      : "no-cache";
    const etag = etagFor(stats);
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, {
        etag,
        "cache-control": cacheControl,
        ...framingHeaders(request, config),
      });
      response.end();
      return;
    }
    const headers = {
      "content-type": contentType,
      etag,
      "cache-control": cacheControl,
      vary: "accept-encoding",
      ...framingHeaders(request, config),
    };

    const compressible =
      stats.size > COMPRESS_OVER_BYTES &&
      /^(?:text\/|application\/(?:json|javascript))/u.test(contentType) &&
      /\bgzip\b/u.test(request.headers["accept-encoding"] ?? "");
    if (compressible) {
      const entry = await gzipped(filePath, stats);
      response.writeHead(200, {
        ...headers,
        "content-encoding": "gzip",
        "content-length": entry.body.length,
      });
      if (request.method === "HEAD") response.end();
      else response.end(entry.body);
      return;
    }

    response.writeHead(200, { ...headers, "content-length": stats.size });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  };
};
