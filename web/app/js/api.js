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
    /**
     * @type {{
     *   sessionId: string,
     *   tools: import("./store.js").Tool[],
     *   prompts: import("./store.js").Prompt[],
     *   instructions: string,
     *   serverInfo: { name?: string, version?: string } | null,
     * }}
     */
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

  /**
   * Fetch one MCP prompt, i.e. REA's own instructions for a situation.
   *
   * @param {string} prompt
   * @param {Record<string, string>} [args]
   * @returns {Promise<{ prompt: string, description: string, messages: { role: string, text: string }[] }>}
   */
  getPrompt: (prompt, args) =>
    request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt, arguments: args ?? {} }),
    }),

  /**
   * Session-owned completion values for one prompt argument.
   *
   * @param {string} prompt
   * @param {string} argument
   * @param {string} [value] partial text the user has typed
   * @returns {Promise<{ prompt: string, argument: string, values: string[], unavailable?: string }>}
   */
  completePromptArgument: (prompt, argument, value = "") =>
    request("/api/complete", {
      method: "POST",
      body: JSON.stringify({ prompt, argument, value }),
    }),

  /**
   * Configuration presence for the host integrations REA never inspects.
   * Presence only — nothing is executed, so this is not availability.
   */
  hostIntegrations: () => request("/api/host-integrations"),

  /**
   * Per-feature host support: which integrations this platform/arch blocks.
   *
   * Distinct from `hostIntegrations()`, which reports configuration. An
   * unsupported host cannot be fixed by configuring anything, and an
   * unconfigured integration does not need a different machine.
   *
   * @returns {Promise<{ host: { platform: string, arch: string }, features: { id: string, label: string, supported: boolean, supportedWhen: string, reason: string, remediation: string, tools: string[] }[], declared: number }>}
   */
  hostRestrictions: () => request("/api/host-restrictions"),

  /**
   * Export the session's canonical Evidence bundle.
   *
   * REA only exports by absolute local path, which a browser cannot name, so
   * the server picks the path and returns the bytes; this is the only way the
   * web app can hand a user a bundle REA itself will accept back.
   *
   * @param {string} [name] destination filename inside the session workspace
   * @returns {Promise<{ name: string, path: string, bytes: number, sha256: string, contents: string, receipt: { records: number, unknowns: number, bytes: number, empty: boolean, summary: string } | null }>}
   */
  exportEvidenceBundle: (name) =>
    request("/api/evidence/export", {
      method: "POST",
      body: JSON.stringify(name === undefined ? {} : { name }),
    }),

  /**
   * Import an Evidence bundle the user chose. REA validates the whole file
   * before merging anything, so a rejected bundle leaves the session unchanged.
   *
   * @param {File} file
   * @returns {Promise<{ staged: { path: string, name: string, bytes: number, sha256: string }, accepted: boolean, result: unknown, rejection: { code: string, message: string | null, remediation: string | null } | null }>}
   */
  importEvidenceBundle: async (file) => {
    const response = await fetch(
      `/api/evidence/import?filename=${encodeURIComponent(file.name)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      },
    );
    const payload = await response.json();
    if (!response.ok)
      throw new ApiError(payload?.error?.message ?? "Import failed.", {
        code: payload?.error?.code,
        status: response.status,
      });
    return payload;
  },

  /**
   * Per-operation capability readiness from `rea capabilities`.
   *
   * @returns {Promise<{
   *   capabilities: { provider: { id: string, name?: string, version?: string | null },
   *     shared_limitations?: string[],
   *     groups: { operations: string[], effects?: string[], limitations?: string[],
   *       available: boolean, reason?: string | null, availability_code?: string | null }[] }[],
   *   analysis_provider_candidates: { provider: { id: string, name?: string },
   *     availability: { status: string, code?: string | null, reason?: string | null } }[],
   *   unavailable_reason?: string,
   * }>}
   */
  capabilities: () =>
    request("/api/capabilities", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  samples: () =>
    request("/api/samples", { method: "POST", body: JSON.stringify({}) }),

  createFolderUpload: (name) =>
    request("/api/folder-uploads", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  uploadFolderFile: async (folderId, relativePath, file) => {
    const query = new URLSearchParams({ folderId, path: relativePath });
    const response = await fetch(`/api/folder-uploads/file?${query}`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        ...(sessionId === null ? {} : { "x-rea-session": sessionId }),
      },
      body: file,
    });
    const payload = await response.json();
    if (!response.ok)
      throw new ApiError(payload?.error?.message ?? "Folder upload failed.", {
        code: payload?.error?.code ?? "folder_upload_failed",
        status: response.status,
      });
    return payload;
  },

  writeText: (name, text) =>
    request("/api/workspace/text", {
      method: "POST",
      body: JSON.stringify({ name, text }),
    }),

  /** Download one regular file from the active session workspace. */
  downloadWorkspaceFile: async (name) => {
    const response = await fetch(
      `/api/workspace/download?name=${encodeURIComponent(name)}`,
      {
        headers: sessionId === null ? {} : { "x-rea-session": sessionId },
      },
    );
    if (!response.ok) {
      let message = `Download failed with ${response.status}.`;
      try {
        message = (await response.json())?.error?.message ?? message;
      } catch {
        // Keep the status message when the body is not JSON.
      }
      throw new ApiError(message, {
        code: "workspace_download_failed",
        status: response.status,
      });
    }
    return response.blob();
  },

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
