/**
 * Browser client for the REA web API.
 *
 * Tool calls stream server-sent progress events so the UI can show what the
 * analysis is doing while it runs.
 */

/**
 * @typedef {{
 *   tool: string,
 *   status: "ok" | "error",
 *   payload: any,
 *   error?: any,
 *   durationMs: number,
 *   provenance?: any,
 * }} CallResult
 */

/** @typedef {{ phase: string, message: string, completed?: number, total?: number }} Progress */

/** @type {string | null} */
let sessionId = null;
export const getSessionId = () => sessionId;

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, remediation?: string }} [details]
   */
  constructor(message, { code, status, remediation } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.remediation = remediation;
  }
}

/**
 * @param {string} path
 * @param {RequestInit & { headers?: Record<string, string> }} [options]
 * @returns {Promise<any>}
 */
const request = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(sessionId === null ? {} : { "x-rea-session": sessionId }),
      ...(options.headers ?? {}),
    },
  });
  if (response.status === 204) return null;
  const text = await response.text();
  let payload;
  try {
    payload = text.length === 0 ? null : JSON.parse(text);
  } catch {
    payload = { error: { message: text.slice(0, 400) } };
  }
  if (!response.ok) {
    throw new ApiError(
      payload?.error?.message ?? `Request failed with ${response.status}.`,
      {
        code: payload?.error?.code ?? "http_error",
        status: response.status,
        remediation: payload?.error?.remediation,
      },
    );
  }
  return payload;
};

export const api = {
  status: () => request("/api/status"),
  doctor: () => request("/api/doctor"),
  installRuntime: () => request("/api/runtime/install", { method: "POST" }),
  sources: () => request("/api/sources"),
  workspace: () => request("/api/workspace"),

  async startSession() {
    /** @type {{ sessionId: string, tools: import("./store.js").Tool[] }} */
    const payload = await request("/api/sessions", { method: "POST" });
    sessionId = payload.sessionId;
    return payload;
  },

  async endSession() {
    if (sessionId === null) return;
    const id = sessionId;
    sessionId = null;
    await fetch("/api/sessions", {
      method: "DELETE",
      headers: { "x-rea-session": id },
    }).catch(() => undefined);
  },

  /**
   * @param {File} file
   * @param {(sent: number, total: number) => void} [onProgress]
   */
  async upload(file, onProgress) {
    return streamUpload(file, onProgress);
  },

  samples: () =>
    request("/api/samples", { method: "POST", body: JSON.stringify({}) }),

  writeText: (name, text) =>
    request("/api/workspace/text", {
      method: "POST",
      body: JSON.stringify({ name, text }),
    }),

  /**
   * Call one MCP tool. Progress notifications arrive through `onProgress`.
   *
   * @param {string} tool
   * @param {Record<string, unknown>} [args]
   * @param {{ onProgress?: (progress: Progress) => void, signal?: AbortSignal }} [options]
   * @returns {Promise<CallResult>}
   */
  async callTool(tool, args, { onProgress, signal } = {}) {
    const response = await fetch("/api/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson, application/json",
        ...(sessionId === null ? {} : { "x-rea-session": sessionId }),
      },
      body: JSON.stringify({ tool, arguments: args ?? {} }),
      signal,
    });
    if (!response.ok) {
      const text = await response.text();
      let message = `Tool call failed with ${response.status}.`;
      try {
        message = JSON.parse(text)?.error?.message ?? message;
      } catch {
        // Keep the status message when the body is not JSON.
      }
      throw new ApiError(message, {
        code: "tool_call_failed",
        status: response.status,
      });
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/x-ndjson")) return response.json();
    if (response.body === null)
      throw new ApiError("The tool call returned no response body.", {
        code: "empty_body",
      });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    /** @type {CallResult | undefined} */
    let result;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          const message = JSON.parse(line);
          if (message.type === "progress") onProgress?.(message.progress);
          else if (message.type === "result") result = message.result;
        }
        newline = buffer.indexOf("\n");
      }
    }
    if (result === undefined)
      throw new ApiError("The tool call ended without a result.", {
        code: "no_result",
      });
    return result;
  },
};

/**
 * Stage one file into the session workspace.
 *
 * @param {File} file
 * @param {(sent: number, total: number) => void} [onProgress]
 * @returns {Promise<{ name: string, path: string, bytes: number, sha256: string }>}
 */
const streamUpload = async (file, onProgress) => {
  /** @type {RequestInit & { duplex: string }} */
  const options = {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-rea-filename": encodeURIComponent(file.name),
    },
    body: file,
    // Chromium needs this for a streaming request body; it is not in lib.dom.
    duplex: "half",
  };
  const response = await fetch(
    `/api/upload?filename=${encodeURIComponent(file.name)}`,
    options,
  );
  onProgress?.(file.size, file.size);
  const payload = await response.json();
  if (!response.ok)
    throw new ApiError(payload?.error?.message ?? "Upload failed.", {
      code: payload?.error?.code,
      status: response.status,
    });
  return payload;
};
