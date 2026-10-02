// GameBuddy embedded-surface boundary check.
//
// Asserts that the vendored Magic Context Pi extension still contains the
// GameBuddy-specific embedded-runtime boundaries. Fragments are compared with
// whitespace collapsed so a reformat (line wrap, indentation change) cannot
// silently disable this gate — an assertion that can never match is worse than
// no assertion, because it reads as coverage.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourceRoot = resolve(import.meta.dirname, "..", "src");
const indexSource = await readFile(resolve(sourceRoot, "index.ts"), "utf8");
const collapse = (value) => value.replace(/\s+/g, " ");
const normalizedSource = collapse(indexSource);

const required = [
  // CLI authoring runners are disabled whenever the runtime is embedded.
  "const cliAuthoringDisabled = embeddedRuntime || embeddedRuntimeDisablesCliAuthoringCommands()",
  "const recompRunner = cliAuthoringDisabled",
  "const wrapupRunner = cliAuthoringDisabled",
  // An embedded runtime selects the SDK-backed runner, never a CLI spawner.
  "embeddedRuntime ? new EmbeddedPiHistorianRunner() : undefined",
  // The Host-facing private seam that binds the embedded ModelRegistry.
  "getEmbeddedHistorianRuntimeBinding",
];
for (const fragment of required) {
  if (!normalizedSource.includes(collapse(fragment))) {
    throw new Error(`missing GameBuddy embedded boundary: ${fragment}`);
  }
}

console.log(JSON.stringify({
  state: "passed",
  cliBackedAdminRunners: "disabled-in-embedded-mode",
  historianRunner: "embedded-sdk-only",
  externalPiCli: "forbidden-in-embedded-mode",
}));
