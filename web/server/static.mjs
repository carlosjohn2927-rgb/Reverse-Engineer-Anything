import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

import { framingHeaders } from "./http.mjs";

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

/**
 * Serve the single-page app from `web/app`.
 *
 * Unknown paths without a file extension fall back to `index.html` so client
 * routes survive a reload. Paths are normalized and confined to the root.
 */
export const createStaticHandler = ({ root, config }) => {
  const absoluteRoot = resolve(root);
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
    if (stats === undefined && extname(rel) === "") {
      filePath = join(absoluteRoot, "index.html");
      stats = await stat(filePath).catch(() => undefined);
    }
    if (stats === undefined) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const contentType =
      CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": stats.size,
      "cache-control": "no-cache",
      ...framingHeaders(request, config),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  };
};
