import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type WebAssetName =
  "index.html" | "styles.css" | "app.js" | "state.js" | "version.js";

const assetDirectories = [
  fileURLToPath(new URL("./web/", import.meta.url)),
  fileURLToPath(new URL("../web/", import.meta.url)),
];
const cache = new Map<WebAssetName, Promise<Buffer>>();

async function readAsset(name: WebAssetName): Promise<Buffer> {
  let lastError: unknown;
  for (const directory of assetDirectories) {
    try {
      return await readFile(join(directory, name));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`web asset ${name} is unavailable`);
}

export function loadWebAsset(name: WebAssetName): Promise<Buffer> {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const loading = readAsset(name);
  cache.set(name, loading);
  return loading;
}
