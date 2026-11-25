import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root of this checkout (one level above `web/`). */
export const REPOSITORY_ROOT = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "..",
);

/** Built REA CLI entry inside this checkout. */
export const REA_ENTRY = join(REPOSITORY_ROOT, "scripts", "rea.mjs");

/** Candidate Node.js 24 binaries, ordered by preference. */
const node24Candidates = (environment) => [
  environment.REA_WEB_NODE,
  join(REPOSITORY_ROOT, ".cache", "node24", "bin", "node"),
  join(homedir(), ".local", "rea-web", "node24", "bin", "node"),
];

const parsePort = (raw, fallback) => {
  if (raw === undefined || raw === "") return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) return fallback;
  const port = Number(raw);
  return port <= 65535 ? port : fallback;
};

/** Milliseconds from an environment value; invalid input keeps the fallback. */
const parseDuration = (raw, fallback) => {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const parseCount = (raw, fallback) => {
  const value = parseDuration(raw, Number.NaN);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const parseOrigins = (raw) =>
  (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/**
 * Resolve runtime configuration once at startup.
 *
 * - `REA_WEB_PORT` / `PORT` choose the preview port (default 4180).
 * - `REA_WEB_HOST` chooses the bind address (default 0.0.0.0 so the hosted
 *   preview can reach the server).
 * - `REA_WEB_NODE` optionally points at a Node.js 24+ binary used to run the
 *   REA CLI. Otherwise compatible candidates are probed.
 * - `REA_WEB_WORKSPACE` overrides the per-vault upload workspace directory.
 * - `REA_WEB_ALLOWED_ORIGINS` adds exact browser origins permitted by CORS.
 */
export const loadConfig = (environment = process.env) => {
  const workspace = environment.REA_WEB_WORKSPACE;
  return {
    host: environment.REA_WEB_HOST ?? "0.0.0.0",
    port: parsePort(environment.REA_WEB_PORT ?? environment.PORT, 4180),
    reaEntry: REA_ENTRY,
    repositoryRoot: REPOSITORY_ROOT,
    node24Candidates: node24Candidates(environment),
    workspaceDirectory:
      workspace !== undefined && isAbsolute(workspace)
        ? workspace
        : join(homedir(), ".local", "rea-web", "workspaces"),
    allowedOrigins: parseOrigins(environment.REA_WEB_ALLOWED_ORIGINS),
    uploadLimitBytes: 512 * 1024 * 1024,
    clientTimeoutMs: 15 * 60 * 1000,
    // A browser that closes without DELETE leaves a REA child behind; reap it.
    sessionIdleTtlMs: parseDuration(
      environment.REA_WEB_SESSION_TTL_MS,
      10 * 60 * 1000,
    ),
    sessionIdleSweepMs: parseDuration(
      environment.REA_WEB_SESSION_SWEEP_MS,
      60 * 1000,
    ),
    maxSessions: parseCount(environment.REA_WEB_MAX_SESSIONS, 8),
  };
};

/** Report whether the compiled REA runtime is present. */
export const reaRuntimeBuilt = (config) => existsSync(config.reaEntry);
