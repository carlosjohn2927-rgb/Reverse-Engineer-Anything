import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { sha256File } from "./sources.mjs";

/**
 * REA's four evidence-bundle tools all take absolute local filesystem paths.
 * A browser has neither an absolute path to offer nor a way to fetch one back,
 * so every one of them is unusable from the web app on its own. This module is
 * the translation layer: it turns a browser download into a file in the
 * session workspace, and a session-workspace file into a browser download.
 *
 * It deliberately does not validate, parse or rewrite bundle bytes. REA owns
 * the canonical format and is the only thing that may judge it; anything this
 * module did to the bytes could only make a corrupt bundle look acceptable.
 */

/** The filename a download offers. Never derived from a user-supplied path. */
export const BUNDLE_DOWNLOAD_NAME = "rea-evidence-bundle.json";

/**
 * Why a browser cannot use these tools directly. Rendered by the client so the
 * limitation is stated rather than silently worked around.
 */
export const BUNDLE_PATH_CONTRACT = {
  /**
   * REA rejects relative paths, so the server always supplies an absolute one
   * inside the session workspace and never accepts one from the request.
   */
  serverSuppliesPath: true,
  /** Content is data. REA never executes an imported bundle. */
  importIsData: true,
  /** Import validates before merging; a rejected bundle changes nothing. */
  importIsAtomic: true,
};

/**
 * Choose a destination inside the session workspace for an exported bundle.
 *
 * @param {string} workspace absolute session workspace directory
 * @param {string} [name] operator-chosen filename; sanitised, never trusted
 */
export const bundlePathIn = (workspace, name) => {
  const requested = basename(name ?? BUNDLE_DOWNLOAD_NAME);
  const safe = requested.replaceAll(/[^\w.\-()+ ]/gu, "_");
  return join(workspace, safe.length === 0 ? BUNDLE_DOWNLOAD_NAME : safe);
};

/**
 * Stage an uploaded bundle in the session workspace so REA can import it by
 * absolute path. Mirrors `stageUpload`, but keeps the `.json` suffix visible in
 * the name the operator sees back.
 *
 * @param {string} workspace absolute session workspace directory
 * @param {File | Blob | import("node:fs").ReadStream | string} contents
 *   a staged temporary file path, written by the route's streaming body
 * @param {string} [name]
 */
export const stageBundleUpload = async (workspace, contents, name) => {
  await mkdir(workspace, { recursive: true });
  const destination = bundlePathIn(workspace, name);
  await copyFile(String(contents), destination);
  return {
    path: destination,
    name: basename(destination),
    bytes: (await stat(destination)).size,
    sha256: await sha256File(destination),
  };
};

/**
 * Read an exported bundle back off disk for the browser to download, after
 * proving it is the file REA wrote and not something else in the workspace.
 *
 * @param {string} path absolute path reported by REA's export result
 * @param {string} workspace the session workspace the path must stay inside
 */
export const readExportedBundle = async (path, workspace) => {
  const bytes = await readFile(path);
  const stats = await stat(path);
  if (!path.startsWith(workspace))
    throw new Error(
      "REA exported the bundle outside the session workspace; refusing to serve it.",
    );
  return {
    path,
    name: basename(path),
    bytes: stats.size,
    sha256: await sha256File(path),
    // The canonical bytes, unparsed and unmodified: REA's manifest digests are
    // byte-stable, so any re-serialisation here would invalidate them.
    contents: bytes.toString("utf8"),
  };
};

/**
 * Describe what REA said about an export or import without claiming more.
 *
 * REA's export receipt reports counts; it does not report that an importer will
 * accept the file. The wording keeps that distinction visible.
 *
 * @param {Record<string, unknown> | null | undefined} receipt
 */
export const describeReceipt = (receipt) => {
  if (receipt === null || receipt === undefined) return null;
  const records = Number(receipt.records ?? 0);
  const unknowns = Number(receipt.unknowns ?? 0);
  const bytes = Number(receipt.bytes ?? 0);
  return {
    records,
    unknowns,
    bytes,
    /** An empty bundle is valid, and is not evidence that analysis ran. */
    empty: records === 0 && unknowns === 0,
    summary:
      records === 0 && unknowns === 0
        ? "REA wrote a valid bundle with no records. That is a fact about this session, not a failed export."
        : `${records} record${records === 1 ? "" : "s"} and ${unknowns} unknown revision${unknowns === 1 ? "" : "s"} in ${bytes} byte${bytes === 1 ? "" : "s"}.`,
  };
};
