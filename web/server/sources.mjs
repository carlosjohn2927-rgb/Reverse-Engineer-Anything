import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";

/** Archive and container extensions worth surfacing in a folder tree. */
const ARTIFACT_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".aar",
  ".apk",
  ".apks",
  ".appimage",
  ".asar",
  ".bin",
  ".bundle",
  ".bz2",
  ".class",
  ".deb",
  ".dex",
  ".dll",
  ".dmg",
  ".dol",
  ".elf",
  ".exe",
  ".exe",
  ".firmware",
  ".gz",
  ".img",
  ".ipa",
  ".iso",
  ".jar",
  ".lz4",
  ".macho",
  ".nupkg",
  ".o",
  ".pcap",
  ".pcapng",
  ".pck",
  ".pex",
  ".pkg",
  ".pyc",
  ".so",
  ".tar",
  ".tgz",
  ".vmdk",
  ".war",
  ".wasm",
  ".whl",
  ".xz",
  ".zip",
  ".zst",
  ".gguf",
  ".safetensors",
  ".onnx",
  ".pt",
  ".ptx",
  ".cubin",
  ".dat",
  ".db",
  ".sqlite",
  ".sqlite3",
]);

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".turbo",
  ".venv",
  "node_modules",
  "dist",
  "build",
  "__pycache__",
  ".next",
  ".output",
  "target",
  "coverage",
  "third_party",
]);

export const sha256File = (path) =>
  new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolvePromise(hash.digest("hex")));
  });

/** Whether an absolute path stays inside a root directory. */
export const isInside = (root, candidate) => {
  const absoluteRoot = resolve(root);
  const absolute = resolve(candidate);
  return absolute === absoluteRoot || absolute.startsWith(absoluteRoot + sep);
};

/**
 * Describe a directory tree for the source picker: folders, inspectable
 * artifacts and everything else, bounded in depth and entry count.
 */
export const describeTree = async (root, directory = root, depth = 0) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nodes = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (depth === 0 && entry.name.startsWith(".")) continue;
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const relative = absolute.slice(root.length + 1);
    if (entry.isDirectory()) {
      const children =
        depth < 2 ? await describeTree(root, absolute, depth + 1) : [];
      nodes.push({
        kind: "directory",
        name: entry.name,
        path: relative,
        children,
      });
      continue;
    }
    if (!entry.isFile()) continue;
    const stats = await stat(absolute);
    nodes.push({
      kind: "file",
      name: entry.name,
      path: relative,
      absolute,
      bytes: stats.size,
      inspectable: ARTIFACT_EXTENSIONS.has(extname(entry.name).toLowerCase()),
    });
    if (nodes.length >= 400) break;
  }
  return nodes;
};

/** Copy an uploaded file into the session workspace under its own name. */
export const stageUpload = async (workspace, filename, contents) => {
  await mkdir(workspace, { recursive: true });
  const safe = basename(filename).replaceAll(/[^\w.\-()+ ]/gu, "_");
  const destination = join(workspace, safe.length === 0 ? "artifact" : safe);
  await copyFile(contents, destination);
  return {
    path: destination,
    name: basename(destination),
    bytes: (await stat(destination)).size,
    sha256: await sha256File(destination),
  };
};
