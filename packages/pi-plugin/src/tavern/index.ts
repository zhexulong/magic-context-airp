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

export {
  publishGameBuddyAuthoredStableCatalog,
  replaceGameBuddyAuthoredStableCatalog,
  type TavernAuthoredContextRuntimeCapability,
} from "../gamebuddy-authored-context-bridge.internal";

export {
  TAVERN_NARRATIVE_GATE_MARKER_SCHEMA,
  GAME_OPERATIONAL_GATE_MARKER_SCHEMA,
  type TavernProviderStartObservation,
  validateTavernNarrativeGateMarkerConfig,
  validateGameOperationalGateMarkerConfig,
  registerTavernNarrativeGateMarker,
  clearTavernNarrativeGateMarker,
  registerGameOperationalGateMarker,
  registerTavernProviderStartObserver,
  registerTavernNarrativeGateMarkerHook,
} from "../tavern-narrative-gate-marker";
