/** JSON responder shared by every API route. */
export const sendJson = (response, status, value) => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
};

/** Uniform API failure envelope. */
export const sendError = (response, status, code, message, details) => {
  sendJson(response, status, {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  });
};

/** Read a bounded JSON request body. */
export const readJsonBody = async (request, limitBytes) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes)
      return {
        ok: false,
        status: 413,
        message: "Request body exceeds the configured limit.",
      };
    chunks.push(chunk);
  }
  if (size === 0) return { ok: true, value: {} };
  try {
    return {
      ok: true,
      value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
  } catch {
    return {
      ok: false,
      status: 400,
      message: "Request body is not valid JSON.",
    };
  }
};

/** Extract the transport host (without port) of an incoming request. */
export const requestHostname = (request) => {
  const host = request.headers.host;
  if (typeof host !== "string") return undefined;
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":")[0];
};

/**
 * The hosted preview frames the app in an iframe whose origin differs from the
 * server's. Those responses must be embeddable; anything else stays same-origin.
 */
export const isPreviewRequest = (request, config) => {
  const hostname = requestHostname(request);
  if (hostname === undefined) return false;
  if (hostname === "localhost" || hostname === "127.0.0.1") return false;
  return config.allowedOrigins.length === 0;
};

/** Whether a browser Origin is allowed to call the API. */
export const originAllowed = (origin, request, config) => {
  if (origin === undefined) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]"
  )
    return true;
  if (parsed.host === request.headers.host) return true;
  return config.allowedOrigins.includes(origin);
};

/** Apply framing headers appropriate for preview or same-origin responses. */
export const framingHeaders = (request, config) =>
  isPreviewRequest(request, config)
    ? { "x-frame-options": "", "content-security-policy": "frame-ancestors *" }
    : { "x-frame-options": "SAMEORIGIN" };
