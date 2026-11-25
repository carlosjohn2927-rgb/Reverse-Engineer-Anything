/**
 * Test entry point: starts the web server on a free port, runs every
 * `*.mjs` test against it, then shuts the server down.
 *
 *   node web/test/run.mjs [--keep]
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const port = 4318;

const server = spawn(process.execPath, [join(root, "server", "index.mjs")], {
  cwd: root,
  env: { ...process.env, REA_WEB_PORT: String(port) },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverLog = "";
server.stderr.on("data", (chunk) => {
  serverLog += chunk.toString();
});

const url = `http://127.0.0.1:${port}`;
const waitForServer = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/status`);
      if (response.ok) return true;
    } catch {
      // The server has not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
};

const stop = () => {
  if (!server.killed) server.kill("SIGTERM");
};

const tests = readdirSync(here).filter(
  (name) => name.endsWith(".mjs") && name !== "run.mjs",
);

if (!(await waitForServer())) {
  console.error(`Server did not start:\n${serverLog}`);
  stop();
  process.exit(1);
}

let failed = 0;
for (const name of tests) {
  console.log(`\n=== ${name} ===`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, name), url], {
      stdio: "inherit",
    });
    child.on("exit", (status) => resolve(status ?? 1));
  });
  if (code !== 0) failed += 1;
}

if (process.argv.includes("--keep"))
  console.log(`\nServer left running at ${url}`);
else stop();

if (failed > 0) {
  console.error(`\n${failed} test file(s) failed.`);
  process.exit(1);
}
console.log(`\n${tests.length} test file(s) passed.`);
