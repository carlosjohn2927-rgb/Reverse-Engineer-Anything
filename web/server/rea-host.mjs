import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { McpSession } from "./mcp.mjs";
import { resolveNodeRuntime } from "./runtime.mjs";

/** How long a child may take to log its listening URL. */
const STARTUP_TIMEOUT_MS = 30_000;
/** Concurrent tool calls allowed per browser session before 429. */
export const MAX_CONCURRENT_CALLS_PER_SESSION = 2;

/**
 * One browser session maps to one REA MCP server child process.
 *
 * REA's HTTP mode serves one logical agent session; a dedicated child gives
 * every browser session its own binary session, retained Evidence and
 * per-session cleanup on disconnect.
 */
export class ReaSession {
  #child;
  #client;
  #state = "starting";
  #calls = new Set();
  #workspace;
  #closed = false;
  #lastUsedAt = Date.now();

  constructor({ child, client, workspace, id }) {
    this.#child = child;
    this.#client = client;
    this.#workspace = workspace;
    this.id = id;
    this.#state = "ready";
  }

  get state() {
    return this.#state;
  }

  get client() {
    return this.#client;
  }

  /** REA's own operating instructions, as returned by `initialize`. */
  get instructions() {
    return this.#client.instructions ?? "";
  }

  /** Server identity from `initialize`, e.g. `{ name: "rea", version: "6.8.0" }`. */
  get serverInfo() {
    return this.#client.serverInfo ?? null;
  }

  get workspace() {
    return this.#workspace;
  }

  get activeCalls() {
    return this.#calls.size;
  }

  /** Timestamp of the last tool call, used by idle reaping. */
  get lastUsedAt() {
    return this.#lastUsedAt;
  }

  /** Record activity so a live browser is never reaped. */
  touch() {
    this.#lastUsedAt = Date.now();
  }

  /** Run one tool call, tracking it for cancellation on disconnect. */
  async callTool(
    name,
    args,
    /** @type {{ onProgress?: (progress: any) => void, signal?: AbortSignal }} */ {
      onProgress,
      signal,
    } = {},
  ) {
    if (this.#state !== "ready")
      throw new Error("The analysis session is not ready.");
    if (this.#calls.size >= MAX_CONCURRENT_CALLS_PER_SESSION)
      throw Object.assign(
        new Error(
          "This session already has the maximum number of running calls.",
        ),
        { statusCode: 429 },
      );
    this.#lastUsedAt = Date.now();
    const controller = new AbortController();
    this.#calls.add(controller);
    try {
      return await this.#client.request(
        "tools/call",
        { name, arguments: args },
        { onProgress, signal: controller.signal },
      );
    } finally {
      this.#calls.delete(controller);
    }
  }

  /**
   * Fetch one MCP prompt: REA's own instructions for a situation, with the
   * caller's arguments substituted. Prompts do not run analysis, so they are
   * not counted toward the tool-call concurrency limit, but they share the
   * session's cancellation set so a disconnect stops them too.
   */
  async callPrompt(
    name,
    args,
    /** @type {{ signal?: AbortSignal }} */ { signal } = {},
  ) {
    if (this.#state !== "ready")
      throw new Error("The analysis session is not ready.");
    this.#lastUsedAt = Date.now();
    const controller = new AbortController();
    this.#calls.add(controller);
    try {
      return await this.#client.request(
        "prompts/get",
        { name, arguments: args },
        { signal: signal ?? controller.signal },
      );
    } finally {
      this.#calls.delete(controller);
    }
  }

  /**
   * Ask REA for completion values for one prompt argument.
   *
   * REA answers from the live session, so `document`, `procedure` and the
   * Evidence families are empty until a target has been analysed. An empty
   * list is a valid answer, not a failure.
   *
   * @param {string} promptName
   * @param {string} argumentName
   * @param {string} value partial text the user has typed
   */
  async completePromptArgument(promptName, argumentName, value = "") {
    if (this.#state !== "ready")
      throw new Error("The analysis session is not ready.");
    this.#lastUsedAt = Date.now();
    const result = await this.#client.request("completion/complete", {
      ref: { type: "ref/prompt", name: promptName },
      argument: { name: argumentName, value },
    });
    return result?.completion?.values ?? [];
  }

  /** Stop the child process and remove the session workspace. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#state = "closed";
    for (const controller of this.#calls) controller.abort("session closed");
    await this.#client.close().catch(() => undefined);
    await this.#child.kill();
    await rm(this.#workspace, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/** Child process handle with graceful-then-forceful termination. */
const createChildHandle = (child) => {
  let exited = false;
  const exit = new Promise((resolve) => {
    child.on("exit", () => {
      exited = true;
      resolve(undefined);
    });
  });
  return {
    process: child,
    exited: () => exited,
    async kill() {
      if (exited) return;
      child.kill("SIGTERM");
      const timeout = new Promise((resolve) => setTimeout(resolve, 5000));
      await Promise.race([exit, timeout]);
      if (!exited) {
        child.kill("SIGKILL");
        await Promise.race([exit, timeout]);
      }
    },
    onExit: exit,
  };
};

/** Wait for the child to log the JSON listening line. */
const awaitListeningUrl = (child, timeoutMs) =>
  new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error("REA did not start listening in time."));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n")) {
        if (!line.includes("MCP transport listening")) continue;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed.url === "string") {
            clearTimeout(timer);
            child.stderr.off("data", onData);
            resolve(parsed.url);
          }
        } catch {
          // Non-JSON log lines are ignored.
        }
      }
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`REA exited before listening (code ${code}).`));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

/**
 * Owns the REA process fleet for this web server: runtime resolution, one MCP
 * child per browser session, and the optional provisioned Node.js runtime.
 */
export class ReaHost {
  #config;
  #log;
  #node;
  #sessions = new Map();
  #nextId = 1;
  #sweeper;

  constructor({ config, log }) {
    this.#config = config;
    this.#log = log ?? (() => undefined);
  }

  get nodeExecutable() {
    return this.#node;
  }

  /** Resolve (and cache) the Node.js binary used for REA children. */
  async ready() {
    this.#node ??= await resolveNodeRuntime(this.#config, this.#log);
    return this.#node;
  }

  /** Point future children at a specific runtime (after provisioning). */
  useNode(executable) {
    this.#node = executable;
  }

  get sessionCount() {
    return this.#sessions.size;
  }

  /** Session ids and idle ages, for status reporting. */
  describeSessions() {
    const now = Date.now();
    return [...this.#sessions.values()].map((session) => ({
      id: session.id,
      state: session.state,
      activeCalls: session.activeCalls,
      idleMs: now - session.lastUsedAt,
    }));
  }

  /**
   * Reap sessions whose browser stopped calling (tab closed, network gone)
   * and cap the fleet so a leak can never exhaust the host's memory.
   */
  reapIdleSessions() {
    const now = Date.now();
    const ttl = this.#config.sessionIdleTtlMs;
    const reaped = [];
    for (const session of [...this.#sessions.values()]) {
      if (session.activeCalls > 0) continue;
      if (now - session.lastUsedAt < ttl) continue;
      reaped.push(session.id);
      void this.closeSession(session.id);
    }
    if (reaped.length > 0) this.#log({ event: "session-reap", ids: reaped });
    this.#enforceSessionCap();
    return reaped;
  }

  /** Close the oldest idle sessions once the fleet exceeds its cap. */
  #enforceSessionCap() {
    const max = this.#config.maxSessions;
    if (this.#sessions.size <= max) return;
    const idle = [...this.#sessions.values()]
      .filter((session) => session.activeCalls === 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const session of idle) {
      if (this.#sessions.size <= max) break;
      void this.closeSession(session.id);
    }
  }

  /** Start the periodic sweeper (no-op when a TTL of 0 disables it). */
  startReaper() {
    if (this.#sweeper !== undefined) return;
    const interval = this.#config.sessionIdleSweepMs;
    if (!(interval > 0)) return;
    this.#sweeper = setInterval(() => this.reapIdleSessions(), interval);
    this.#sweeper.unref?.();
  }

  stopReaper() {
    if (this.#sweeper === undefined) return;
    clearInterval(this.#sweeper);
    this.#sweeper = undefined;
  }

  /** Start one isolated REA MCP server and connect a client to it. */
  async createSession() {
    const node = await this.ready();
    const id = `s${this.#nextId++}`;
    const workspace = join(this.#config.workspaceDirectory, id);
    const child = spawn(
      node,
      [
        this.#config.reaEntry,
        "mcp",
        "--http",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
      ],
      {
        cwd: this.#config.repositoryRoot,
        env: {
          ...process.env,
          REA_WEB_SESSION_WORKSPACE: workspace,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    child.stderr.setEncoding("utf8");
    const handle = createChildHandle(child);
    let session;
    try {
      const url = await awaitListeningUrl(child, STARTUP_TIMEOUT_MS);
      const client = await McpSession.connect({
        url,
        timeoutMs: this.#config.clientTimeoutMs,
      });
      session = new ReaSession({ child: handle, client, workspace, id });
      this.#sessions.set(id, session);
      handle.onExit.then(() => {
        this.#sessions.delete(id);
      });
      this.#log({ event: "session-start", id, url });
      this.#enforceSessionCap();
      return session;
    } catch (error) {
      await handle.kill();
      throw error;
    }
  }

  async getSession(id) {
    const session = this.#sessions.get(id);
    if (session === undefined) return undefined;
    if (session.state === "closed") return undefined;
    return session;
  }

  async closeSession(id) {
    const session = this.#sessions.get(id);
    if (session === undefined) return;
    this.#sessions.delete(id);
    await session.close();
  }

  async shutdown() {
    this.stopReaper();
    await Promise.all([...this.#sessions.values()].map((s) => s.close()));
    this.#sessions.clear();
  }
}
