/* global process */

import { readFile, stat } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";

import { WEB_API_VERSION, WEB_ASSET_VERSION } from "../dist/web-contract.js";

const distribution = fileURLToPath(new URL("../dist/web/", import.meta.url));
const requiredAssets = [
  "index.html",
  "styles.css",
  "app.js",
  "state.js",
  "version.js",
];

for (const name of requiredAssets) {
  const metadata = await stat(`${distribution}${name}`);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`packaged web asset ${name} is missing or empty`);
  }
}

const [html, app, version] = await Promise.all([
  readFile(`${distribution}index.html`, "utf8"),
  readFile(`${distribution}app.js`, "utf8"),
  readFile(`${distribution}version.js`, "utf8"),
]);

const expectedVersionSource = [
  `WEB_API_VERSION = "${WEB_API_VERSION}"`,
  `WEB_ASSET_VERSION = "${WEB_ASSET_VERSION}"`,
];
for (const expected of expectedVersionSource) {
  if (!version.includes(expected)) {
    throw new Error(`packaged version.js does not contain ${expected}`);
  }
}
for (const commandSchema of [
  "agent-relay-web-resolve.v1",
  "agent-relay-web-session-action.v1",
]) {
  if (!app.includes(commandSchema)) {
    throw new Error(`packaged app.js does not use ${commandSchema}`);
  }
}
if (
  !html.includes(
    `name="agent-relay-web-asset-version" content="${WEB_ASSET_VERSION}"`,
  )
) {
  throw new Error("packaged HTML asset version does not match the daemon");
}
if (!app.includes('api("/v1/web/meta")')) {
  throw new Error("packaged app.js does not negotiate API compatibility");
}

process.stdout.write(
  `${JSON.stringify({
    schema: "agent-relay-web-package-check.v1",
    apiVersion: WEB_API_VERSION,
    assetVersion: WEB_ASSET_VERSION,
    assets: requiredAssets,
  })}\n`,
);
