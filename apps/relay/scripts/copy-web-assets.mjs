import { copyFile, mkdir, rm } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const source = fileURLToPath(new URL("../web/", import.meta.url));
const target = fileURLToPath(new URL("../dist/web/", import.meta.url));

await mkdir(packageDirectory, { recursive: true });
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const name of ["index.html", "styles.css", "app.js", "state.js"]) {
  await copyFile(`${source}${name}`, `${target}${name}`);
}
