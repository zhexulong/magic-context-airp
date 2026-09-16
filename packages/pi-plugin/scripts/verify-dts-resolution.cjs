const fs = require("fs");
const path = require("path");

// NodeNext/TS declaration resolution: importing "./x.js" resolves to "./x.d.ts".
function toDts(spec) {
  const base = spec.replace(/\.js$/, "");
  return base + ".d.ts";
}

function check(entry, depth = 0, seen = new Set()) {
  if (depth > 12 || seen.has(entry)) return;
  seen.add(entry);
  const f = path.resolve(entry);
  if (!fs.existsSync(f)) {
    console.log("MISSING FILE:", f);
    return;
  }
  const content = fs.readFileSync(f, "utf8");
  const specs = [...content.matchAll(/from\s+"((?:\.\.?\/)[^"]+)"/g)].map((m) => m[1]);
  for (const spec of specs) {
    const resolved = path.resolve(path.dirname(f), toDts(spec));
    const rel = path.relative(process.cwd(), resolved).replace(/\\/g, "/");
    if (fs.existsSync(resolved)) {
      console.log(rel, "OK");
      check(resolved, depth + 1, seen);
    } else {
      console.log("MISSING:", rel, "(spec:", spec + ")");
    }
  }
}
console.log("== memory ==");
check("dist/memory/index.d.ts");
console.log("== tavern ==");
check("dist/tavern/index.d.ts");