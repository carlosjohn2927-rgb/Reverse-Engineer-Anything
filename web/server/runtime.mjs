import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Node.js major version of a candidate binary, or undefined when unusable. */
const probeNodeMajor = (executable) =>
  new Promise((resolve) => {
    const child = spawn(executable, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () => resolve(undefined));
    child.on("exit", () => {
      const match = /^v(\d+)\./u.exec(output.trim());
      resolve(match?.[1] === undefined ? undefined : Number(match[1]));
    });
  });

const isExecutable = async (path) => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Pick the Node.js binary used for REA child processes.
 *
 * The web server itself runs on whatever runtime started it; REA needs the
 * repository's supported Node.js line (SQLite inspection, for example, requires
 * the 24.15+ `node:sqlite` limits API). Children prefer a verified candidate
 * over `process.execPath` so one server can serve every runtime check.
 */
export const resolveNodeRuntime = async (config, log) => {
  for (const candidate of config.node24Candidates) {
    if (candidate === undefined || !(await isExecutable(candidate))) continue;
    const major = await probeNodeMajor(candidate);
    if (major !== undefined && major >= 24) {
      log?.({
        event: "node-runtime",
        source: "candidate",
        path: candidate,
        major,
      });
      return candidate;
    }
  }
  const major = await probeNodeMajor(process.execPath);
  log?.({
    event: "node-runtime",
    source: "process",
    path: process.execPath,
    major: major ?? null,
  });
  return process.execPath;
};

/** True when the running major version can execute TypeScript entry points. */
export const supportsTypeStripping = (major) => major !== undefined;

/** Install a Node.js 24 runtime next to the repository cache directory. */
export const provisionNode24 = async (config, onProgress) => {
  const destination = config.node24Candidates[1];
  if (destination === undefined) throw new Error("No provisioning target.");
  await mkdir(dirname(destination), { recursive: true });
  const staging = `${dirname(destination)}/install`;
  await mkdir(staging, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  onProgress?.("Installing Node.js 24 (npm package `node` 24.22.1)…");
  await new Promise((resolve, reject) => {
    const child = spawn(
      npm,
      [
        "install",
        "--prefix",
        staging,
        "--no-audit",
        "--no-fund",
        "--ignore-scripts=false",
        "node@24.22.1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
      if (errorText.length > 8000) errorText = errorText.slice(-8000);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else
        reject(
          new Error(`npm install node@24.22.1 failed: ${errorText.trim()}`),
        );
    });
  });
  const installed = `${staging}/node_modules/node/bin/node`;
  if (!(await isExecutable(installed)))
    throw new Error("The installed Node.js package is missing its binary.");
  onProgress?.("Moving the runtime into place…");
  const { copyFile, rm } = await import("node:fs/promises");
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(installed, `${destination}.tmp`);
  const { chmod, rename } = await import("node:fs/promises");
  await chmod(`${destination}.tmp`, 0o755);
  await rename(`${destination}.tmp`, destination);
  await rm(staging, { recursive: true, force: true });
  onProgress?.("Node.js 24 installed.");
  return destination;
};
