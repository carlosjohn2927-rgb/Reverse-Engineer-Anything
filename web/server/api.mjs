import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { readJsonBody, sendError, sendJson } from "./http.mjs";
import { generateSamples } from "./samples.mjs";
import { describeTree, sha256File, stageUpload } from "./sources.mjs";
import {
  HOST_RESTRICTED_FEATURES,
  featureSupportFor,
} from "../app/js/host-restrictions.js";
import {
  BUNDLE_DOWNLOAD_NAME,
  bundlePathIn,
  describeReceipt,
  readExportedBundle,
  stageBundleUpload,
} from "./evidence-bundle.mjs";

/** Tools that only make sense for a registered desktop or mobile device. */
const HOST_DEPENDENT_PREFIXES = [
  "adb_",
  "capture_adb",
  "read_adb",
  "pull_adb",
  "push_adb",
  "install_adb",
  "uninstall_adb",
  "start_adb",
  "stop_adb",
  "collect_adb",
  "resolve_adb",
  "list_adb",
  "inspect_adb",
  "gdb_",
  "start_gdb",
  "close_gdb",
  "rizin_debug",
  "start_rizin",
  "close_rizin",
  "list_frida",
  "start_frida",
  "frida_session",
  "load_frida",
  "unload_frida",
  "resume_frida",
  "instrument_with_frida",
  "list_cutter",
  "cutter_command",
  "list_jeb",
  "open_jeb",
  "decompile_jeb",
  "inspect_jeb",
  "start_browser",
  "list_browser",
  "capture_browser",
  "observe_web_session",
  "inspect_web_page",
  "discover_webmcp_tools",
];

const isHostDependent = (name) =>
  HOST_DEPENDENT_PREFIXES.some((prefix) => name.startsWith(prefix));

/** Normalize an MCP tool name to its kebab-case CLI command. */
export const cliCommandFor = (toolName) => toolName.replaceAll("_", "-");

/** Turn a tool result into the shape the browser renders. */
const projectCall = (result) => {
  if (result === undefined)
    return { status: "empty", payload: null, error: null };
  const text = Array.isArray(result.content)
    ? result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
    : "";
  let payload = result.structuredContent ?? null;
  if (payload === null && text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { text };
    }
  }
  const envelope = payload?.error === undefined ? null : payload.error;
  const isError = result.isError === true || envelope !== null;
  return {
    status: isError ? "error" : "ok",
    payload: isError ? null : payload,
    error: isError
      ? {
          code: envelope?.code ?? "tool_error",
          category: envelope?.category ?? "failure",
          message:
            envelope?.message ?? (text.length > 0 ? text : "The tool failed."),
          remediation: envelope?.remediation?.action ?? null,
          retryable: envelope?.retryable === true,
          details: envelope?.details ?? null,
        }
      : null,
    provenance: result._meta?.provenance ?? null,
  };
};

/** Routes that need a live REA session. */
export const createApi = ({ config, host, log }) => {
  const routes = new Map();

  const route = (method, path, handler) => {
    routes.set(`${method} ${path}`, handler);
  };

  const sessionOf = async (request, response, body) => {
    const id = body?.sessionId ?? request.headers["x-rea-session"];
    if (typeof id !== "string") {
      sendError(response, 400, "session_missing", "Create a session first.");
      return undefined;
    }
    const session = await host.getSession(id);
    if (session === undefined) {
      sendError(
        response,
        410,
        "session_expired",
        "This analysis session ended. Start a new session.",
      );
      return undefined;
    }
    return session;
  };

  // ---- Runtime status -----------------------------------------------------
  route("GET", "/api/status", async (_request, response) => {
    const node = await host.ready();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    /** @type {string | null} */
    let reaVersion = null;
    try {
      const { stdout } = await run(node, [config.reaEntry, "--version"], {
        timeout: 20_000,
      });
      reaVersion = stdout.trim();
    } catch {
      reaVersion = null;
    }
    /** @type {string | null} */
    let nodeVersion = null;
    try {
      const { stdout } = await run(node, ["--version"], { timeout: 10_000 });
      nodeVersion = stdout.trim();
    } catch {
      nodeVersion = null;
    }
    sendJson(response, 200, {
      rea: { version: reaVersion, built: reaVersion !== null },
      runtime: {
        nodeVersion,
        executable: node,
        server: process.version,
        provisioned: node !== process.execPath,
      },
      sessions: host.sessionCount,
      sessionDetail: host.describeSessions(),
      platform: process.platform,
      repositoryRoot: config.repositoryRoot,
    });
  });

  /** Run `rea doctor` through the resolved runtime. */
  route("GET", "/api/doctor", async (_request, response) => {
    const node = await host.ready();
    const { spawn } = await import("node:child_process");
    const child = spawn(node, [config.reaEntry, "doctor", "--format", "json"], {
      cwd: config.repositoryRoot,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    await new Promise((resolve) => child.on("exit", resolve));
    try {
      sendJson(response, 200, JSON.parse(stdout));
    } catch {
      sendJson(response, 200, {
        healthy: false,
        scope_checks: [],
        providerInspections: [],
        raw: `${stdout}\n${stderr}`.trim().slice(0, 20_000),
      });
    }
  });

  /** Provision the Node.js 24 runtime used for REA child processes. */
  route("POST", "/api/runtime/install", async (_request, response) => {
    const { provisionNode24 } = await import("./runtime.mjs");
    try {
      const installed = await provisionNode24(config, (message) =>
        log({ event: "runtime-provision", message }),
      );
      host.useNode(installed);
      sendJson(response, 200, { ok: true, executable: installed });
    } catch (error) {
      sendError(
        response,
        502,
        "provision_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  // ---- Sessions -----------------------------------------------------------
  route("POST", "/api/sessions", async (_request, response) => {
    try {
      const session = await host.createSession();
      const tools = await session.client.request("tools/list", {});
      // Prompts are advertised by every REA server (`prompts.listChanged`), so
      // read them here rather than leaving the workspace blind to them. A
      // server that omits the capability must not fail the whole session.
      const prompts = await session.client
        .request("prompts/list", {})
        .catch(() => ({ prompts: [] }));
      sendJson(response, 201, {
        sessionId: session.id,
        tools: tools.tools.map((tool) => ({
          name: tool.name,
          title: tool.title ?? tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? { type: "object" },
          outputSchema: tool.outputSchema ?? null,
          annotations: tool.annotations ?? null,
          cli: `rea ${cliCommandFor(tool.name)}`,
          hostDependent: isHostDependent(tool.name),
        })),
        prompts: (prompts.prompts ?? []).map((prompt) => ({
          name: prompt.name,
          title: prompt.title ?? prompt.name,
          description: prompt.description ?? "",
          arguments: (prompt.arguments ?? []).map((argument) => ({
            name: argument.name,
            description: argument.description ?? "",
            required: argument.required === true,
          })),
        })),
        // REA's operating instructions are only sent once, during
        // `initialize`. Expose them so the workspace can show what REA says
        // about its own scope and limits instead of hiding it in a handshake.
        instructions: session.instructions,
        serverInfo: session.serverInfo,
      });
    } catch (error) {
      sendError(
        response,
        502,
        "session_start_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  route("DELETE", "/api/sessions", async (request, response, _body) => {
    const id = request.headers["x-rea-session"];
    if (typeof id === "string") await host.closeSession(id);
    response.writeHead(204).end();
  });

  // ---- Prompts ------------------------------------------------------------
  // REA's six guided workflows are MCP prompts: the server returns REA's own
  // instructions for a situation, with the caller's arguments substituted.
  route("POST", "/api/prompt", async (request, response, body) => {
    const session = await sessionOf(request, response, body);
    if (session === undefined) return;
    const name = body?.prompt;
    const args = body?.arguments ?? {};
    if (typeof name !== "string" || name.length === 0)
      return sendError(
        response,
        400,
        "prompt_missing",
        "Name a prompt to get.",
      );
    if (typeof args !== "object" || args === null || Array.isArray(args))
      return sendError(
        response,
        400,
        "arguments_invalid",
        "Arguments must be an object.",
      );
    try {
      const result = await session.callPrompt(name, args);
      sendJson(response, 200, {
        prompt: name,
        description: result.description ?? "",
        messages: (result.messages ?? []).map((message) => ({
          role: message.role ?? "user",
          text:
            typeof message.content?.text === "string"
              ? message.content.text
              : typeof message.content === "string"
                ? message.content
                : "",
        })),
      });
    } catch (error) {
      sendError(
        response,
        502,
        "prompt_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  // ---- Prompt argument completions ----------------------------------------
  // REA advertises `completions` and fills 14 of its 25 guided-workflow
  // arguments from the live session. Without this route the browser had to
  // guess document names, Evidence ids and provider names by hand.
  route("POST", "/api/complete", async (request, response, body) => {
    const session = await sessionOf(request, response, body);
    if (session === undefined) return;
    const prompt = body?.prompt;
    const argument = body?.argument;
    if (typeof prompt !== "string" || prompt.length === 0)
      return sendError(response, 400, "prompt_missing", "Name a prompt.");
    if (typeof argument !== "string" || argument.length === 0)
      return sendError(response, 400, "argument_missing", "Name an argument.");
    try {
      const values = await session.completePromptArgument(
        prompt,
        argument,
        typeof body?.value === "string" ? body.value : "",
      );
      sendJson(response, 200, {
        prompt,
        argument,
        values: values.map(String),
      });
    } catch (error) {
      // A completion failure must not stop the user from typing a value, so
      // report an empty list alongside the reason rather than a hard error.
      sendJson(response, 200, {
        prompt,
        argument,
        values: [],
        unavailable: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ---- Tool calls ---------------------------------------------------------
  route("POST", "/api/call", async (request, response, body) => {
    const session = await sessionOf(request, response, body);
    if (session === undefined) return;
    const name = body?.tool;
    const args = body?.arguments ?? {};
    if (typeof name !== "string" || name.length === 0)
      return sendError(response, 400, "tool_missing", "Name a tool to call.");
    if (typeof args !== "object" || args === null || Array.isArray(args))
      return sendError(
        response,
        400,
        "arguments_invalid",
        "Arguments must be an object.",
      );

    const startedAt = Date.now();
    // Stream NDJSON progress so the browser can narrate a long analysis; the
    // stream always ends with exactly one `result` record.
    const acceptsStream = String(request.headers.accept ?? "").includes(
      "application/x-ndjson",
    );
    const started = Date.now();
    const emit = (record) => {
      if (!acceptsStream) return;
      if (!streaming) {
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        });
        streaming = true;
      }
      response.write(`${JSON.stringify(record)}\n`);
    };
    let streaming = false;
    try {
      session.touch();
      const result = await session.callTool(name, args, {
        onProgress: (progress) =>
          emit({
            type: "progress",
            progress: {
              phase: progress.message?.split(":")[0] ?? "analysis",
              message: progress.message ?? "",
              completed: progress.progress ?? 0,
              total: progress.total ?? 0,
            },
          }),
      });
      const projected = {
        tool: name,
        durationMs: Date.now() - startedAt,
        ...projectCall(result),
      };
      if (acceptsStream) {
        emit({ type: "result", result: projected });
        response.end();
      } else {
        sendJson(response, 200, projected);
      }
    } catch (error) {
      const failure = {
        tool: name,
        durationMs: Date.now() - started,
        status: "error",
        payload: null,
        error: {
          code: /** @type {any} */ (error)?.code ?? "tool_call_failed",
          category: "failure",
          message: error instanceof Error ? error.message : String(error),
          remediation: null,
          retryable: /** @type {any} */ (error)?.statusCode !== 429,
          details: null,
        },
      };
      if (acceptsStream) {
        emit({ type: "result", result: failure });
        response.end();
      } else {
        sendJson(
          response,
          /** @type {any} */ (error)?.statusCode ?? 502,
          failure,
        );
      }
    }
  });

  // ---- Files --------------------------------------------------------------
  /** Stream an upload to disk, then hash and stage it in the workspace. */
  route("PUT", "/api/upload", async (request, response, _body, url) => {
    const session = await sessionOf(request, response, undefined);
    if (session === undefined) return;
    const filename = url.searchParams.get("filename") ?? "artifact";
    const safe = basename(filename);
    const temporary = join(session.workspace, `${randomUUID()}.partial`);
    await mkdir(session.workspace, { recursive: true });
    const limit = config.uploadLimitBytes;
    let received = 0;
    const out = createWriteStream(temporary);
    try {
      for await (const chunk of request) {
        received += chunk.length;
        if (received > limit) {
          out.destroy();
          await import("node:fs/promises").then(({ rm }) =>
            rm(temporary, { force: true }),
          );
          return sendError(
            response,
            413,
            "upload_too_large",
            `Uploads are limited to ${Math.round(limit / (1024 * 1024))} MiB.`,
          );
        }
        if (!out.write(chunk))
          await new Promise((resolve) =>
            out.once("drain", () => resolve(undefined)),
          );
      }
      await new Promise((resolve, reject) => {
        out.end(
          /** @param {Error | null | undefined} error */
          (error) =>
            error === undefined || error === null
              ? resolve(undefined)
              : reject(error),
        );
      });
      // stageUpload copies the temporary file under its own name so REA sees
      // the caller's filename while the workspace stays free of partials.
      const staged = await stageUpload(session.workspace, safe, temporary);
      const { rm } = await import("node:fs/promises");
      await rm(temporary, { force: true });
      sendJson(response, 201, staged);
    } catch (error) {
      out.destroy();
      sendError(
        response,
        502,
        "upload_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  // ---- Local sources ------------------------------------------------------
  route("GET", "/api/sources", async (_request, response) => {
    const nodes = await describeTree(
      config.repositoryRoot,
      config.repositoryRoot,
    ).catch(() => []);
    sendJson(response, 200, {
      root: config.repositoryRoot,
      nodes: flattenTree(nodes),
    });
  });

  /**
   * Configuration presence for the host integrations REA never inspects.
   *
   * adb, frida, gdb, rizin, jeb, cutter and the rest gate 51 of the 233 tools,
   * and neither `capabilities` nor `doctor` reports them. This only observes
   * whether the setting REA documents is present or the binary resolves on
   * PATH — it does not run them, so "configured" must never become
   * "available". Read-only: nothing is spawned or executed here.
   */
  route("GET", "/api/host-integrations", async (_request, response) => {
    const watched = [
      "REA_ADB_PATH",
      "REA_FRIDA_PYTHON",
      "REA_PWNTOOLS_PYTHON",
      "REA_GDB_COMMAND",
      "REA_RIZIN_COMMAND",
      "REA_JEB_MCP_URL",
      "REA_CUTTER_BRIDGE_DIR",
      "REA_TSHARK_COMMAND",
      "REA_APKTOOL_COMMAND",
      "REA_BINWALK_COMMAND",
      "REA_OBJDUMP_COMMAND",
    ];
    const binaries = [
      "adb",
      "gdb",
      "rizin",
      "tshark",
      "apktool",
      "binwalk",
      "objdump",
    ];
    const { accessSync, constants } = await import("node:fs");
    const { delimiter, join: joinPath } = await import("node:path");
    const onPath = [];
    const searchPath = process.env.PATH ?? "";
    for (const binary of binaries) {
      const found = searchPath
        .split(delimiter)
        .filter((entry) => entry.length > 0)
        .some((entry) => {
          try {
            accessSync(joinPath(entry, binary), constants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
      if (found) onPath.push(binary);
    }
    sendJson(response, 200, {
      // Use null, not undefined: JSON.stringify drops undefined keys, which
      // made "this setting is not set" indistinguishable from "this setting
      // was never probed" on the client.
      env: Object.fromEntries(
        watched.map((name) => {
          const value = process.env[name];
          return [
            name,
            typeof value === "string" && value.length > 0 ? value : null,
          ];
        }),
      ),
      onPath,
      // Presence is all this can establish; the UI says so next to the result.
      verified: false,
    });
  });

  /**
   * Per-operation capability readiness.
   *
   * `rea doctor` answers "is this engine installed". It does not answer the
   * question a user actually has when a tool fails: "is *this* operation
   * available, and if not, why". `rea capabilities` does — it reports every
   * provider, the operations it serves, whether each group is available, the
   * machine-readable availability code and the remediation. This is the only
   * surface that covers the 51 host-dependent tools (adb, frida, gdb, rizin,
   * jeb, cutter), which doctor omits entirely.
   *
   * Some providers need a live target before they can answer, so this is a
   * POST: it may run within a session's context.
   */
  route("POST", "/api/capabilities", async (request, response, body) => {
    const session = await sessionOf(request, response, body);
    if (session === undefined) return;
    const { spawn } = await import("node:child_process");
    const node = await host.ready();
    const child = spawn(
      node,
      [config.reaEntry, "capabilities", "--format", "json"],
      {
        cwd: config.repositoryRoot,
        env: { ...process.env, ...(body?.env ?? {}) },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    await new Promise((resolve) => child.on("exit", resolve));
    try {
      sendJson(response, 200, JSON.parse(stdout));
    } catch {
      // A capabilities read must never break the Setup view; report the
      // failure as data so the UI can show it next to the providers.
      sendJson(response, 200, {
        open: false,
        capabilities: [],
        analysis_provider_candidates: [],
        unavailable_reason: `${stdout}\n${stderr}`.trim().slice(0, 4_000),
      });
    }
  });

  /** Generate the built-in demo samples inside a session workspace. */
  route("POST", "/api/samples", async (request, response, body) => {
    const session = await sessionOf(request, response, body);
    if (session === undefined) return;
    const directory = join(session.workspace, "samples");
    try {
      const generated = await generateSamples(directory);
      const files = await Promise.all(
        generated.map(async ({ id, path }) => ({
          id,
          name: basename(path),
          path,
          bytes: (await stat(path)).size,
          sha256: await sha256File(path),
          extension: extname(path),
        })),
      );
      sendJson(response, 201, { directory, files });
    } catch (error) {
      sendError(
        response,
        502,
        "sample_generation_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  /** Write a byte range into the session workspace (used by the hex viewer). */
  route("POST", "/api/workspace/text", async (request, response, body) => {
    const session = await sessionOf(request, response, body);
    if (session === undefined) return;
    const name = basename(String(body?.name ?? "input.txt"));
    const text = String(body?.text ?? "");
    const destination = join(session.workspace, name);
    await writeFile(destination, text, "utf8");
    sendJson(response, 201, {
      path: destination,
      bytes: Buffer.byteLength(text),
      sha256: await sha256File(destination),
    });
  });

  // ---- Host-restricted features -----------------------------------------
  //
  // `HOST_RESTRICTED_FEATURES` gates 13 tools on the *host*: on an unsupported
  // platform/arch no environment variable lets them pass. That appeared in
  // neither `capabilities` nor `doctor`, so an unsupported host and an
  // unconfigured one looked identical. These rules are pure functions of
  // platform and arch, so they are evaluated here rather than guessed at.
  route("GET", "/api/host-restrictions", async (_request, response) => {
    const { platform, arch } = process;
    const features = featureSupportFor(platform, arch);
    sendJson(response, 200, {
      host: { platform, arch },
      // `supported` is a statement about this host only; it says nothing about
      // whether the integration is configured or reachable.
      features,
      declared: HOST_RESTRICTED_FEATURES.length,
    });
  });

  // ---- Evidence bundles ------------------------------------------------
  //
  // REA exports and imports bundles by absolute local path. A browser cannot
  // name one and cannot read one back, so these two routes are the only way an
  // evidence bundle can cross into or out of the web app. The path is always
  // chosen here, inside the session workspace: the request never supplies one.

  /** Write the session's canonical bundle and return it as a download. */
  route("POST", "/api/evidence/export", async (request, response, body) => {
    const session = await sessionOf(request, response, body);
    if (session === undefined) return;
    const destination = bundlePathIn(
      session.workspace,
      typeof body?.name === "string" ? body.name : BUNDLE_DOWNLOAD_NAME,
    );
    // REA refuses to write into a directory that does not exist yet, and a
    // fresh session has no workspace until something is placed in it.
    await mkdir(session.workspace, { recursive: true });
    const result = projectCall(
      await session.callTool(
        "export_evidence_bundle",
        { path: destination, overwrite: true },
        {},
      ),
    );
    if (result.status !== "ok") {
      sendError(
        response,
        502,
        "bundle_export_failed",
        String(
          result.error?.message ?? "REA did not export the evidence bundle.",
        ),
        { remediation: result.error?.remediation ?? null },
      );
      return;
    }
    try {
      const file = await readExportedBundle(destination, session.workspace);
      sendJson(response, 200, {
        name: file.name,
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
        contents: file.contents,
        receipt: describeReceipt(/** @type {any} */ (result.payload)),
      });
    } catch (error) {
      sendError(
        response,
        502,
        "bundle_read_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  /**
   * Stage an uploaded bundle and ask REA to import it. Validation happens
   * inside REA before anything merges, so a rejected bundle changes nothing.
   */
  route(
    "PUT",
    "/api/evidence/import",
    async (request, response, _body, url) => {
      const session = await sessionOf(request, response, undefined);
      if (session === undefined) return;
      const name = url.searchParams.get("filename") ?? BUNDLE_DOWNLOAD_NAME;
      const temporary = join(session.workspace, `${randomUUID()}.partial`);
      await mkdir(session.workspace, { recursive: true });
      const limit = config.uploadLimitBytes;
      let received = 0;
      const out = createWriteStream(temporary);
      try {
        for await (const chunk of request) {
          received += chunk.length;
          if (received > limit) {
            out.destroy();
            const { rm } = await import("node:fs/promises");
            await rm(temporary, { force: true });
            return sendError(
              response,
              413,
              "upload_too_large",
              `Evidence bundles are limited to ${Math.round(limit / (1024 * 1024))} MiB.`,
            );
          }
          if (!out.write(chunk))
            await new Promise((resolve) =>
              out.once("drain", () => resolve(undefined)),
            );
        }
        await new Promise((resolve, reject) => {
          out.end(
            /** @param {Error | null | undefined} error */
            (error) =>
              error === undefined || error === null
                ? resolve(undefined)
                : reject(error),
          );
        });
        const staged = await stageBundleUpload(
          session.workspace,
          temporary,
          name,
        );
        const { rm } = await import("node:fs/promises");
        await rm(temporary, { force: true });
        const result = projectCall(
          await session.callTool(
            "import_evidence_bundle",
            { path: staged.path },
            {},
          ),
        );
        // A rejected bundle is a verdict about the file, not a server failure.
        // It is reported at 200 with its own code so the UI can quote REA.
        sendJson(response, 200, {
          staged,
          accepted: result.status === "ok",
          result: result.status === "ok" ? (result.payload ?? null) : null,
          rejection:
            result.status === "ok"
              ? null
              : {
                  code: result.error?.code ?? "import_rejected",
                  message: result.error?.message ?? null,
                  remediation: result.error?.remediation ?? null,
                },
        });
      } catch (error) {
        out.destroy();
        sendError(
          response,
          502,
          "bundle_import_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  route("GET", "/api/workspace", async (request, response) => {
    const session = await sessionOf(request, response, undefined);
    if (session === undefined) return;
    const entries = await readdir(session.workspace, {
      withFileTypes: true,
    }).catch(() => []);
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(session.workspace, entry.name);
      const stats = await stat(path);
      files.push({
        name: entry.name,
        path,
        bytes: stats.size,
        modified: stats.mtimeMs,
      });
    }
    sendJson(response, 200, { workspace: session.workspace, files });
  });

  /** Dispatch one request; returns false when no route matches. */
  const handle = async (request, response, url) => {
    const handler = routes.get(`${request.method} ${url.pathname}`);
    if (handler === undefined) return false;
    if (request.method === "POST" || request.method === "PUT") {
      if (request.method === "PUT") {
        await handler(request, response, undefined, url);
        return true;
      }
      const body = await readJsonBody(request, 8 * 1024 * 1024);
      if (!body.ok) {
        sendError(response, body.status, "body_invalid", body.message);
        return true;
      }
      await handler(request, response, body.value, url);
      return true;
    }
    await handler(request, response, undefined, url);
    return true;
  };

  return { handle };
};

/** Depth-first flatten of the source tree with a depth marker. */
const flattenTree = (nodes, depth = 0, out = []) => {
  for (const node of nodes) {
    out.push({
      kind: node.kind,
      name: node.name,
      path: node.path,
      ...(node.absolute === undefined ? {} : { absolute: node.absolute }),
      ...(node.bytes === undefined ? {} : { bytes: node.bytes }),
      ...(node.inspectable === undefined
        ? {}
        : { inspectable: node.inspectable }),
      depth,
    });
    if (node.children !== undefined) flattenTree(node.children, depth + 1, out);
  }
  return out;
};
