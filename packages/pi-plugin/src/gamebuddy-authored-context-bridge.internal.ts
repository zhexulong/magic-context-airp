import {
	__gamebuddyBindAuthoredVolatileTurn,
	__gamebuddyClearAuthoredMaterialization,
	__gamebuddyClearAuthoredVolatileTurn,
	__gamebuddyReadAuthoredMaterialization,
	__gamebuddyReplaceAuthoredMaterialization,
	type GameBuddyAuthoredStablePlanProjection,
	type GameBuddyAuthoredStableSourceRef,
	type GameBuddyAuthoredVolatileSourceRef,
	type GameBuddyChatContextScope,
	materializeGameBuddyAuthoredStableCatalog,
} from "./gamebuddy-stable-context-source";

export type TavernAuthoredContextRuntimeCapability = Readonly<{
	prepare(transientPreflightId: string): GameBuddyAuthoredStablePlanProjection;
	assertInstall(
		durableTurnId: string,
		refs: readonly GameBuddyAuthoredStableSourceRef[],
		volatileRefs?: readonly GameBuddyAuthoredVolatileSourceRef[],
	): void;
	clearVolatileForTurn(durableTurnId: string): void;
	materializeVolatileForTurn(
		turnId: string,
		acceptedPlayerText: string,
		boundedVisibleTail: string,
	): Readonly<{
		refs: readonly GameBuddyAuthoredVolatileSourceRef[];
		tokenCount: number;
	}>;
	clear(): Promise<void>;
}>;
const ids = (v: string, field: string) => {
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(v)) throw new Error(`invalid_${field}`);
};
const sameScope = (
	left: GameBuddyChatContextScope,
	right: GameBuddyChatContextScope,
): boolean =>
	left.continuityId === right.continuityId &&
	left.sessionId === right.sessionId &&
	left.surface === right.surface &&
	left.threadId === right.threadId &&
	left.profile.profileId === right.profile.profileId &&
	left.profile.revision === right.profile.revision &&
	left.profile.canonicalHash === right.profile.canonicalHash;
type CapabilityEntry = {
	readonly scope: GameBuddyChatContextScope;
	readonly materialization: ReturnType<
		typeof materializeGameBuddyAuthoredStableCatalog
	>;
	active: boolean;
	volatileTurnId?: string;
};
const capabilityEntries = new WeakMap<object, CapabilityEntry>();

function mintCapability(
	scope: GameBuddyChatContextScope,
	materialization: ReturnType<typeof materializeGameBuddyAuthoredStableCatalog>,
): TavernAuthoredContextRuntimeCapability {
	const entry: CapabilityEntry = { scope, materialization, active: true };
	const assertCurrent = (): void => {
		if (!entry.active) throw new Error("gamebuddy_authored_context_cleared");
		if (
			__gamebuddyReadAuthoredMaterialization(scope.sessionId) !==
			entry.materialization
		)
			throw new Error("gamebuddy_authored_context_stale_superseded");
	};
	const capability: TavernAuthoredContextRuntimeCapability = Object.freeze({
		prepare(id) {
			ids(id, "transient_preflight_id");
			assertCurrent();
			return Object.freeze({
				sourceRefs: Object.freeze(
					entry.materialization.sources.map(
						({ content: _, budgetTokens: __, provenance: ___, ...ref }) =>
							Object.freeze(ref),
					),
				),
				stableTokenCount: entry.materialization.budgetTokens,
				volatileSourceRefs: Object.freeze([]),
				volatileSourceCandidates: Object.freeze(
					entry.materialization.volatileSources.map((source) =>
						Object.freeze({
							...source,
							selectionKeys: Object.freeze(source.selectionKeys),
						}),
					),
				),
				volatileTokenCount: entry.materialization.volatileSources.reduce(
					(total, source) => total + source.budgetTokens,
					0,
				),
			});
		},
		assertInstall(turnId, refs, volatileRefs = []) {
			ids(turnId, "durable_turn_id");
			assertCurrent();
			const expected = entry.materialization.sources.map(
				({ content: _, budgetTokens: __, provenance: ___, ...ref }) => ref,
			);
			const expectedVolatile = entry.materialization.volatileSources.map(
				({ content: _, budgetTokens: __, selectionKeys: ___, ...ref }) => ref,
			);
			if (
				refs.length !== expected.length ||
				refs.some(
					(r, i) => JSON.stringify(r) !== JSON.stringify(expected[i]),
				) ||
				volatileRefs.length > expectedVolatile.length ||
				volatileRefs.some(
					(r, i) => JSON.stringify(r) !== JSON.stringify(expectedVolatile[i]),
				)
			)
				throw new Error("gamebuddy_authored_context_plan_mismatch");
			__gamebuddyBindAuthoredVolatileTurn(scope.sessionId, {
				turnId,
				sourceRefs: volatileRefs,
			});
			entry.volatileTurnId = turnId;
		},
		clearVolatileForTurn(turnId) {
			ids(turnId, "durable_turn_id");
			if (entry.volatileTurnId === undefined) return;
			if (entry.volatileTurnId !== turnId)
				throw new Error("gamebuddy_authored_context_cross_turn");
			__gamebuddyClearAuthoredVolatileTurn(scope.sessionId, turnId);
			entry.volatileTurnId = undefined;
		},
		materializeVolatileForTurn(turnId, acceptedPlayerText, boundedVisibleTail) {
			ids(turnId, "durable_turn_id");
			assertCurrent();
			const corpus = `${acceptedPlayerText}\n${boundedVisibleTail}`
				.normalize("NFC")
				.toLocaleLowerCase();
			const refs = entry.materialization.volatileSources
				.filter((source) =>
					source.selectionKeys.some((key) => {
						const trimmed = key.normalize("NFC").trim().toLocaleLowerCase();
						return trimmed.length > 0 && corpus.includes(trimmed);
					}),
				)
				.map(({ content: _, budgetTokens: __, selectionKeys: ___, ...ref }) =>
					Object.freeze(ref),
				);
			const result = Object.freeze({
				refs: Object.freeze(refs),
				tokenCount: refs.reduce(
					(total, ref) =>
						total +
						(entry.materialization.volatileSources.find(
							(source) => source.sourceId === ref.sourceId,
						)?.budgetTokens ?? 0),
					0,
				),
			});
			__gamebuddyBindAuthoredVolatileTurn(scope.sessionId, {
				turnId,
				sourceRefs: result.refs,
			});
			entry.volatileTurnId = turnId;
			return result;
		},
		async clear() {
			if (!entry.active) return;
			entry.active = false;
			if (entry.volatileTurnId !== undefined)
				__gamebuddyClearAuthoredVolatileTurn(
					scope.sessionId,
					entry.volatileTurnId,
				);
			__gamebuddyClearAuthoredMaterialization(
				scope.sessionId,
				entry.materialization,
			);
		},
	});
	capabilityEntries.set(capability as object, entry);
	return capability;
}

export function publishGameBuddyAuthoredStableCatalog(
	scope: GameBuddyChatContextScope,
	catalog: unknown,
): TavernAuthoredContextRuntimeCapability {
	const existing = __gamebuddyReadAuthoredMaterialization(scope.sessionId);
	if (existing !== undefined && !sameScope(existing.scope, scope))
		throw new Error("gamebuddy_authored_context_scope_conflict");
	const materialization = materializeGameBuddyAuthoredStableCatalog(
		catalog,
		scope,
	);
	__gamebuddyReplaceAuthoredMaterialization(scope.sessionId, materialization);
	return mintCapability(scope, materialization);
}

/** Construction-private atomic replacement. Only the current capability may replace its exact mount. */
export function replaceGameBuddyAuthoredStableCatalog(
	currentCapability: TavernAuthoredContextRuntimeCapability,
	scope: GameBuddyChatContextScope,
	catalog: unknown,
): TavernAuthoredContextRuntimeCapability {
	const entry = capabilityEntries.get(currentCapability as object);
	if (
		entry === undefined ||
		!entry.active ||
		!sameScope(entry.scope, scope) ||
		__gamebuddyReadAuthoredMaterialization(scope.sessionId) !==
			entry.materialization
	)
		throw new Error("gamebuddy_authored_context_replacement_rejected");
	const materialization = materializeGameBuddyAuthoredStableCatalog(
		catalog,
		scope,
	);
	// Validate the complete replacement before invalidating the current capability.
	// The registry remains unchanged if catalog validation/materialization fails.
	entry.active = false;
	__gamebuddyReplaceAuthoredMaterialization(scope.sessionId, materialization);
	return mintCapability(scope, materialization);
}
/* Replacement invalidates the old capability before installing the new one. */
