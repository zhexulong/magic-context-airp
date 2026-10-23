# GameBuddy Magic Context Fork

This directory is a parent-repository-tracked, project-maintained fork of MIT-licensed
Magic Context. Its version is `0.42.3-airp.1`, and its lineage is:

* branched from upstream `v0.41.0` — `bcd2f7051e501478110660c3ce52a1a486756da3`
  (recorded by commit `4f1565b4c`, "airp Tavern context and memory engine based on upstream v0.41.0")
* synced with upstream `dc952bf3` (`v0.42.3+6`) by merge commit `98c6d94de`

GameBuddy applies its product-specific delta directly in this vendored tree;
the dependency, lockfiles, generated `dist`, SBOM, and third-party license inventory
must be regenerated and verified from this exact tracked source before release.

## GameBuddy delta: `memory.domain`

The fork adds an explicit configuration selector:

```json
{
  "memory": {
    "domain": "coding-project" | "ongoing-interaction"
  }
}
```

`coding-project` preserves upstream taxonomy and historian behavior.

`ongoing-interaction` changes only Magic Context's own historian parsing and
promotion taxonomy. It uses `SEMANTIC_MEMORY` facts and a dedicated historian
prompt that separates:

- Working Memory — the currently materialized context;
- Episodic Memory — chronological compartments/events;
- Semantic Memory — confirmed durable interaction facts eligible for the
  existing promotion lifecycle;
- Procedural Memory — Host/policy/profile/runtime-owned behavior that Magic
  Context must not create or override.

The domain does **not** give GameBuddy Host a memory adapter, SQLite reader,
recall engine, handoff summary, JSONL copier, experience ledger, or custom
promotion logic. Host only writes the selected domain and feature gates into
its opaque runtime directory.

## GameBuddy delta: the card's closing direction

An imported card's `post_history_instructions` is the one piece of author prose
that belongs AFTER the transcript, the way SillyTavern injects it at depth 0.
The Host carries it verbatim (bounded to 4096 UTF-8 bytes) and publishes it on
the authored-context catalogue as `postHistoryInstructions`, beside the hashed
catalogue body rather than inside it.

The fork renders it in `src/post-history-instructions-pi.ts` and appends it at
`context-handler.ts`'s single success exit — after every reader of the served
array, and therefore outside m[0]/m[1], the fold, the tail-hygiene baseline, the
LKG snapshot, the token accounting and every cache key:

* outside the catalogue hash, so editing a card's closing direction can never
  bust the cached prefix — otherwise a stale tail could ride a fresh prefix, or
  the new prose would only take effect once the cache turned over;
* `role: "user"`, because `pi-ai`'s `resolveTranscript` collapses later `system`
  entries into the LEADING system message on transports without
  mid-conversation system messages, which would hoist the block to the head;
* framed as the closing beat of her own next reply, said TO her — "How your next
  reply ends is yours to write: your own closing beat, in your own voice." — with a
  scope line ("Only that closing beat is at issue here; everything else about you
  stays exactly as it is — the language you speak, and everything you never do.")
  rather than a precedence contest. The block is the last text of the request, so
  it may not describe her in the third person (a card may forbid exactly that) and
  may not name prompts, systems or a runtime (the product floor forbids it); stated
  as scope, a card still cannot talk over the Host's language binding or safety
  rules by position;
* absent for a card that declares nothing: the served array is byte-identical to
  the array without this feature.

## Deliberate rollout state

GameBuddy currently selects `ongoing-interaction`, enables same-scope read-only
Semantic Memory injection, and enables the native embedded Historian while
keeping automatic promotion disabled pending its separate release gate:

```json
{
  "system_prompt_injection": { "enabled": false },
  "memory": {
    "domain": "ongoing-interaction",
    "enabled": true,
    "auto_promote": false,
    "auto_search": { "enabled": false }
  },
  "embedding": { "provider": "off" },
  "dreamer": { "disable": true },
  "sidekick": { "disable": true }
}
```

The fork's native m[0]/m[1] renderer injects only active/permanent
`SEMANTIC_MEMORY` for the exact opaque project identity. Under Magic Context's own context-pressure scheduler, the embedded no-tool
Historian may publish Episodic compartments. Domain-valid `SEMANTIC_MEMORY`
promotion remains gated off in production until `auto_promote` receives its
separate controlled live acceptance. The generic coding-agent system guidance is explicitly disabled, and
GameBuddy's Pi allowlist still excludes all Magic Context `ctx_*` tools. Thus
Host has no Memory writer, reader, recall adapter, SQLite API, handoff, ledger,
or promotion logic.

Magic Context's native ongoing-interaction promotion path has controlled
provider-backed gate coverage (not production enablement): a one-off Episodic fixture publishes no Semantic
Memory, while an explicit confirmed durable preference publishes one scoped
`SEMANTIC_MEMORY` when `auto_promote=true`. This exercises the same embedded pipeline selected by production without
manufacturing production-scale context pressure or enabling the production gate.

This fork is not evidence that cross-session Chat/Game recall, embeddings,
Dreamer, or Sidekick are enabled or accepted. They each need independent
controlled live verification before changing a gate.

## Upstream-shape seams

GameBuddy keeps the fork's divergence as small as the product allows, so an
upstream sync stays a merge instead of a rewrite. Where GameBuddy and upstream
independently introduced the same seam, the fork adopts upstream's shape:

* `resolveHistorianFromConfig(config, harness = PI_HARNESS_KIND)` matches the
  upstream signature. GameBuddy deliberately omits the optional `modelRegistry`
  argument: an embedded runtime's registry only exists after session
  construction, so the runner binds it later through `bindHistorianRunner`
  (driven by the embedding Host) rather than at resolver time.
* `EmbeddedPiHistorianRunner` — a no-tool, one-shot request through the already
  embedded Pi SDK's ModelRegistry. It never spawns `pi`, never opens a user Pi
  session, and never exposes tools. This is GameBuddy's own runner and stays.
* An embedded runtime (`GAMEBUDDY_EMBEDDED_RUNTIME=1`) selects that runner and
  disables the CLI-backed authoring runners. Run
  `node packages/pi-plugin/scripts/verify-gamebuddy-embedded-surface.mjs` to
  check those boundaries; the check collapses whitespace so a reformat cannot
  silently disable it.

## Build checks

```sh
bun install --frozen-lockfile
bun run --filter @cortexkit/opencode-magic-context typecheck
bun run --filter @cortexkit/pi-magic-context typecheck
bun test packages/plugin/src/features/magic-context/memory/domain.test.ts
bun run --filter @cortexkit/pi-magic-context build
```

Do not patch installed `dist` artifacts. Regenerate the ongoing-interaction
prompt after editing its Markdown source:

```sh
bun run packages/plugin/scripts/build-ongoing-interaction-historian-prompt.ts
```
