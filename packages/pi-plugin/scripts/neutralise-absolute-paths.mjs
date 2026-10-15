/**
 * Remove the build machine's absolute path from emitted chunks.
 *
 * bun's CJS interop writes `var __filename = "<absolute path>"` for bundled CommonJS dependencies - here
 * `@jitl/quickjs-singlefile-cjs-release-asyncify` and `@huggingface/transformers` - which bakes the repository
 * path into the shipped artifact and names the build machine. `--define __dirname=undefined
 * --define __filename=undefined` reaches the ESM path (measured: 9 declarations down to 3) but not this
 * synthesized prelude, so the remainder is rewritten here.
 *
 * The value is replaced with the chunk's own URL rather than a guess: these declarations exist for CJS interop,
 * the surrounding bundles bundle their own assets, and the path they currently hold is meaningless at runtime.
 *
 * Usage: node scripts/neutralise-absolute-paths.mjs [distDir]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const distDir = process.argv[2] ?? join(process.cwd(), "dist");
const pattern = /(__dirname|__filename) = "([^"]*node_modules[^"]*)"/gu;

const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith(".js") ? [path] : [];
    });

let rewritten = 0;
for (const file of walk(distDir)) {
    const text = readFileSync(file, "utf8");
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) continue;
    writeFileSync(
        file,
        text.replace(
            pattern,
            (_full, name) =>
                `${name} = (() => { try { return new URL(import.meta.url).pathname; } catch { return ""; } })()`,
        ),
        "utf8",
    );
    rewritten += matches.length;
    console.log(`neutralised ${matches.length} absolute path(s) in ${file}`);
}
console.log(`neutralised ${rewritten} absolute path(s)`);
