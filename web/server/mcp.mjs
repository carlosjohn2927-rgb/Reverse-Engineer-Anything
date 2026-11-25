/**
 * Minimal MCP streamable-HTTP client.
 *
 * The official SDK client owns its own transport lifecycle; the web app needs
 * to keep a session across independent HTTP requests and to observe progress
 * notifications while a tool call is still streaming. Both are part of the
 * MCP streamable-HTTP specification, so this client speaks it directly:
 *
 *   POST /mcp  (initialize | tools/* | DELETE for shutdown)
 *
 * Responses are either `application/json` or a `text/event-stream` body; every
 * SSE event carries one JSON-RPC message, including `notifications/progress`.
 */

const PROTOCOL_VERSION = "2025-06-18";
const INITIALIZE_TIMEOUT_MS = 20_000;

class RpcError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** Split an SSE body into JSON-RPC messages. */
const parseEventStream = (text) => {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/u)) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // A malformed event must not discard well-formed siblings.
    }
  }
  return messages;
};

/**
 * One MCP session bound to a child `rea mcp --http` process.
 *
 * Tool calls are serialized: an REA HTTP server instance tracks one logical
 * agent session and provider resources are single-owner.
 */
export class McpSession {
  #baseUrl;
  #sessionId;
  #nextId = 1;
  #queue = Promise.resolve();
  #closed = false;
  #timeoutMs;

  constructor({ baseUrl, sessionId, timeoutMs = 15 * 60 * 1000 }) {
    this.#baseUrl = baseUrl;
    this.#sessionId = sessionId;
    this.#timeoutMs = timeoutMs;
  }

  get sessionId() {
    return this.#sessionId;
  }

  /** Open a session against a listening MCP endpoint. */
  static async connect({ url, timeoutMs }) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "rea-web", version: "0.1.0" },
        },
      }),
      signal: AbortSignal.timeout(INITIALIZE_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new RpcError(
        `MCP initialize failed with HTTP ${response.status}.`,
        "initialize_failed",
      );
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId === null)
      throw new RpcError(
        "MCP server did not return a session id.",
        "initialize_failed",
      );
    const payload = await response.json().catch(() => undefined);
    if (payload?.error !== undefined)
      throw new RpcError(
        payload.error.message ?? "MCP initialize failed.",
        "initialize_failed",
      );
    const session = new McpSession({ baseUrl: url, sessionId, timeoutMs });
    await session.#post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      undefined,
    );
    return session;
  }

  #headers() {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": this.#sessionId,
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
  }

  async #post(body, signal) {
    return fetch(this.#baseUrl, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Issue one request and collect its JSON-RPC response, forwarding progress
   * notifications. Requests are serialized through a queue.
   */
  async request(
    method,
    params,
    /** @type {{ onProgress?: (progress: any) => void, signal?: AbortSignal }} */ {
      onProgress,
      signal,
    } = {},
  ) {
    if (this.#closed)
      throw new RpcError("The analysis session is closed.", "session_closed");
    const run = async () => {
      const id = this.#nextId++;
      const controller = new AbortController();
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const cancel = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", cancel, { once: true });
      const body = {
        jsonrpc: "2.0",
        id,
        method,
        params: {
          ...params,
          ...(onProgress === undefined
            ? {}
            : { _meta: { progressToken: `web-${id}` } }),
        },
      };
      try {
        const response = await this.#post(
          body,
          AbortSignal.any([controller.signal, timeout]),
        );
        if (response.status === 202) return { result: {} };
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new RpcError(
            `MCP ${method} failed with HTTP ${response.status}. ${text.slice(0, 400)}`,
            response.status === 404 ? "session_expired" : "transport_error",
          );
        }
        const contentType = response.headers.get("content-type") ?? "";
        const messages = contentType.includes("text/event-stream")
          ? parseEventStream(await response.text())
          : [await response.json()];
        let result;
        for (const message of messages) {
          if (message.method === "notifications/progress")
            onProgress?.(message.params);
          if (message.id === id) result = message;
        }
        if (result === undefined)
          throw new RpcError(
            `No response for MCP ${method}.`,
            "transport_error",
          );
        if (result.error !== undefined)
          throw new RpcError(
            result.error.message ?? `MCP ${method} failed.`,
            "rpc_error",
          );
        return result.result;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    };
    const queued = this.#queue.then(run, run);
    this.#queue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  /** Graceful session shutdown (DELETE); failures are non-fatal. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue;
    await fetch(this.#baseUrl, {
      method: "DELETE",
      headers: this.#headers(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  }
}

/**
 * A serialized queue used by callers that own a single REA session (the CLI
 * has one global analysis session, so browser-triggered jobs must not overlap).
 */
export class WorkQueue {
  #tail = Promise.resolve();
  #pending = 0;

  get pending() {
    return this.#pending;
  }

  run(task) {
    this.#pending += 1;
    const started = this.#tail.then(task, task);
    this.#tail = started.then(
      () => undefined,
      () => undefined,
    );
    return started.finally(() => {
      this.#pending -= 1;
    });
  }
}

export { RpcError, PROTOCOL_VERSION };
