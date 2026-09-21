export {
	publishGameBuddyAuthoredStableCatalog,
	replaceGameBuddyAuthoredStableCatalog,
	type TavernAuthoredContextRuntimeCapability,
} from "../gamebuddy-authored-context-bridge.internal";
export {
	GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION,
	type GameBuddyAuthoredContextMaterialization,
	type GameBuddyAuthoredSourceKind,
	type GameBuddyAuthoredStableCatalog,
	type GameBuddyAuthoredStablePlanProjection,
	type GameBuddyAuthoredStableSource,
	type GameBuddyAuthoredStableSourceRef,
	type GameBuddyAuthoredVolatileSource,
	type GameBuddyAuthoredVolatileSourceCandidate,
	type GameBuddyAuthoredVolatileSourceRef,
	type GameBuddyChatContextScope,
	materializeGameBuddyAuthoredStableCatalog,
	validateGameBuddyAuthoredStableCatalog,
} from "../gamebuddy-stable-context-source";

export {
	clearTavernNarrativeGateMarker,
	GAME_OPERATIONAL_GATE_MARKER_SCHEMA,
	registerGameOperationalGateMarker,
	registerTavernNarrativeGateMarker,
	registerTavernNarrativeGateMarkerHook,
	registerTavernProviderStartObserver,
	TAVERN_NARRATIVE_GATE_MARKER_SCHEMA,
	type TavernProviderStartObservation,
	validateGameOperationalGateMarkerConfig,
	validateTavernNarrativeGateMarkerConfig,
} from "../tavern-narrative-gate-marker";
