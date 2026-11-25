/**
 * Production build for the web app.
 *
 * Bundles the ES modules into one minified script and minifies both
 * stylesheets, then fingerprints every asset and rewrites `index.html` to
 * point at the hashed names. Output goes to `web/dist`, which the server
 * prefers over the source tree when it exists.
 *
 *   node web/scripts/build.mjs [--dev]
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";
import { transform as transformCss } from "lightningcss";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const appRoot = join(webRoot, "app");
const outRoot = join(webRoot, "dist");
const dev = process.argv.includes("--dev");

const hash = (contents) =>
  createHash("sha256").update(contents).digest("hex").slice(0, 10);

const write = async (name, contents) => {
  const file = join(outRoot, name);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, contents);
  return { name, bytes: contents.length };
};

const build = async () => {
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(outRoot, { recursive: true });
  const written = [];

  // One script: the whole view graph is small enough to ship in a single
  // request, and bundling removes ten round trips on first paint. It is built
  // into a staging directory so the map can reference a real file, then moved
  // under a content-hashed name.
  const staging = join(outRoot, ".staging");
  await esbuild.build({
    entryPoints: [join(appRoot, "js", "main.js")],
    outdir: staging,
    entryNames: "app",
    bundle: true,
    format: "esm",
    target: ["es2022", "chrome110", "firefox110", "safari16"],
    minify: !dev,
    // A map beside the bundle, not inside it: inline base64 would quadruple
    // the transfer size for something only a debugger reads.
    sourcemap: dev ? "inline" : "linked",
    legalComments: "none",
    logLevel: "warning",
  });
  const scriptCode = await readFile(join(staging, "app.js"));
  const scriptName = `app.${hash(scriptCode)}.js`;
  written.push(await write(`assets/${scriptName}`, scriptCode));
  if (!dev) {
    const map = await readFile(join(staging, "app.js.map"), "utf8");
    // The map names the staging file; the browser asks for the hashed one.
    written.push(await write(`assets/${scriptName}.map`, Buffer.from(map)));
    const rewritten = scriptCode
      .toString("utf8")
      .replace(
        "//# sourceMappingURL=app.js.map",
        `//# sourceMappingURL=${scriptName}.map`,
      );
    await writeFile(join(outRoot, "assets", scriptName), rewritten);
  }
  await rm(staging, { recursive: true, force: true });

  // Both stylesheets, concatenated in cascade order and minified together so
  // shared rules can be merged.
  const cssSources = await Promise.all(
    ["app.css", "tools.css"].map((name) =>
      readFile(join(appRoot, "styles", name)),
    ),
  );
  const cssBundle = Buffer.concat(cssSources);
  const css = transformCss({
    filename: "app.css",
    code: cssBundle,
    minify: !dev,
    sourceMap: dev,
    targets: { chrome: 110 << 16, firefox: 110 << 16, safari: 16 << 16 },
  });
  const cssName = `app.${hash(css.code)}.css`;
  written.push(await write(`assets/${cssName}`, css.code));
  if (typeof css.map === "string")
    written.push(await write(`assets/${cssName}.map`, css.map));

  // Icon and shell.
  const icon = await readFile(join(appRoot, "favicon.svg"));
  const iconName = `favicon.${hash(icon)}.svg`;
  written.push(await write(`assets/${iconName}`, icon));

  const shell = await readFile(join(appRoot, "index.html"), "utf8");
  const html = shell
    .replace(
      /<link rel="stylesheet" href="\/styles\/app\.css" \/>\s*<link rel="stylesheet" href="\/styles\/tools\.css" \/>/u,
      `<link rel="stylesheet" href="/assets/${cssName}" />`,
    )
    .replace(
      /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" \/>/u,
      `<link rel="icon" href="/assets/${iconName}" type="image/svg+xml" />`,
    )
    .replace(
      /<script type="module" src="\/js\/main\.js"><\/script>/u,
      `<script type="module" src="/assets/${scriptName}"></script>`,
    );

  if (
    !(
      html.includes(cssName) &&
      html.includes(scriptName) &&
      html.includes(iconName)
    )
  )
    throw new Error("The shell did not reference every built asset.");

  const htmlBytes = Buffer.from(
    dev ? html : html.replace(/\n\s*/gu, "\n").trim() + "\n",
    "utf8",
  );
  written.push(await write("index.html", htmlBytes));

  const total = written.reduce((sum, file) => sum + file.bytes, 0);
  console.log(`Built web/dist (${dev ? "development" : "production"}):\n`);
  for (const file of written)
    console.log(`  ${String(file.bytes).padStart(8)} B  ${file.name}`);
  console.log(`\n  ${String(total).padStart(8)} B  total`);
};

await build();
