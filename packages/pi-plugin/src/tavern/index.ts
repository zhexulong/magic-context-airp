export {
  type GameBuddyAuthoredSourceKind,
  type GameBuddyChatContextScope,
  type GameBuddyAuthoredStableSource,
  type GameBuddyAuthoredVolatileSource,
  type GameBuddyAuthoredVolatileSourceCandidate,
  type GameBuddyAuthoredStableCatalog,
  type GameBuddyAuthoredStableSourceRef,
  type GameBuddyAuthoredVolatileSourceRef,
  type GameBuddyAuthoredStablePlanProjection,
  type GameBuddyAuthoredContextMaterialization,
  GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION,
  validateGameBuddyAuthoredStableCatalog,
  materializeGameBuddyAuthoredStableCatalog,
} from "../gamebuddy-stable-context-source";

export type {
  TavernAuthoredContextRuntimeCapability,
} from "../gamebuddy-authored-context-bridge.internal";

import {
  type GameBuddyAuthoredVolatileSource,
  type GameBuddyChatContextScope,
  materializeGameBuddyAuthoredStableCatalog,
} from "../gamebuddy-stable-context-source";

/**
 * Convenience helper rendering the stable M0 context block from an authored catalog or materialization.
 */
export function renderGameBuddyStableContextBlock(
  catalogOrMaterialization: unknown,
  scope?: GameBuddyChatContextScope,
): string {
  if (
    catalogOrMaterialization &&
    typeof catalogOrMaterialization === "object" &&
    "renderedBlock" in catalogOrMaterialization &&
    typeof (catalogOrMaterialization as { renderedBlock: unknown }).renderedBlock === "string"
  ) {
    return (catalogOrMaterialization as { renderedBlock: string }).renderedBlock;
  }
  if (!scope) {
    throw new Error("scope_required_for_catalog_materialization");
  }
  return materializeGameBuddyAuthoredStableCatalog(catalogOrMaterialization, scope).renderedBlock;
}

const escapeXmlContent = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const escapeXmlAttr = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * Convenience helper rendering the volatile M1 context block with XML injection defense.
 */
export function renderGameBuddyVolatileContextBlock(
  context:
    | Readonly<{
        snapshotCanonicalHash?: string;
        canonicalHash?: string;
        volatileSources: readonly GameBuddyAuthoredVolatileSource[];
      }>
    | readonly GameBuddyAuthoredVolatileSource[],
  canonicalHash?: string,
): string {
  let sources: readonly GameBuddyAuthoredVolatileSource[];
  let hash: string;

  if (typeof context === "object" && context !== null && "volatileSources" in context) {
    sources = context.volatileSources;
    hash = canonicalHash ?? context.snapshotCanonicalHash ?? context.canonicalHash ?? "";
  } else {
    sources = (context as readonly GameBuddyAuthoredVolatileSource[]) ?? [];
    hash = canonicalHash ?? "";
  }

  if (!sources || sources.length === 0) return "";
  const renderedSources = sources
    .map(
      (source: GameBuddyAuthoredVolatileSource) =>
        `<gamebuddy-volatile-source source-id="${escapeXmlAttr(source.sourceId)}" revision="${escapeXmlAttr(source.revision)}" canonical-hash="${escapeXmlAttr(source.canonicalHash)}">\n${escapeXmlContent(source.content)}\n</gamebuddy-volatile-source>`,
    )
    .join("\n");
  return `<gamebuddy-volatile-context canonical-hash="${escapeXmlAttr(hash)}">\n${renderedSources}\n</gamebuddy-volatile-context>`;
}

export {
  TAVERN_NARRATIVE_GATE_MARKER_SCHEMA,
  type TavernProviderStartObservation,
  validateTavernNarrativeGateMarkerConfig,
  registerTavernNarrativeGateMarker,
  clearTavernNarrativeGateMarker,
  registerTavernProviderStartObserver,
  registerTavernNarrativeGateMarkerHook,
} from "../tavern-narrative-gate-marker";
