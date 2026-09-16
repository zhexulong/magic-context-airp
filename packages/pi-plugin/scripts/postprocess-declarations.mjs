/**
 * Post-process `dist/**\/*.d.ts` emitted for the GameBuddy public subpaths
 * (`./tavern`, `./memory`).
 *
 * Two jobs:
 *
 * 1. Flatten the tsc common-root output. The declaration emit includes the
 *    vendored `plugin/src` files in its program, which pushes tsc's inferred
 *    rootDir up to `packages/`, emitting GameBuddy declarations under
 *    `dist/pi-plugin/src/...` and vendored plugin declarations under
 *    `dist/plugin/src/...`. The GameBuddy public declarations are
 *    self-contained (no alias imports leak into exported signatures), so we
 *    can relocate `dist/pi-plugin/src/**\/*.d.ts` to `dist/**` and drop the
 *    vendored-plugin tree.
 *
 * 2. Rewrite relative import specifiers to explicit `.js` extensions. The
 *    package runtime is ESM (`bun build`), and consumers using NodeNext
 *    resolution need `.js` to find the emitted declarations.
 */
import { readdir, rename, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PLUGIN_SRC = path.join(DIST, "pi-plugin", "src");
const VENDOR_PLUGIN = path.join(DIST, "plugin");
const RELATIVE_IMPORT = /(\bfrom\s+|import\s*\(\s*)"((?:\.\.?\/)[^"]+)"/g;

async function walk(directory) {
  const out = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// 1. Flatten: move every declaration under dist/pi-plugin/src to dist/<rel>.
let moved = 0;
if (await statIsDir(PLUGIN_SRC)) {
  for (const file of await walk(PLUGIN_SRC)) {
    if (!file.endsWith(".d.ts")) continue;
    const rel = path.relative(PLUGIN_SRC, file);
    const dest = path.join(DIST, rel);
    await rename(file, dest);
    moved += 1;
  }
  // Remove leftovers: pi-plugin (everything else) and plugin trees.
  await rm(path.join(DIST, "pi-plugin"), { recursive: true, force: true });
  await rm(VENDOR_PLUGIN, { recursive: true, force: true });
}

// 2. Rewrite relative import specifiers to explicit `.js`.
let rewritten = 0;
let touched = 0;
const emittedDeclarations = (await walk(DIST)).filter((f) => f.endsWith(".d.ts"));
for (const file of emittedDeclarations) {
  const source = await readFile(file, "utf8");
  const next = source.replace(RELATIVE_IMPORT, (_match, prefix, specifier) => {
    if (specifier.endsWith(".js")) return `${prefix}"${specifier}"`;
    rewritten += 1;
    return `${prefix}"${specifier}.js"`;
  });
  if (next !== source) {
    await writeFile(file, next, "utf8");
    touched += 1;
  }
}

process.stdout.write(`moved ${moved} declaration file(s); rewrote ${rewritten} relative import(s) across ${touched} file(s)\n`);

async function statIsDir(p) {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}