import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * The model registry the embedding Host hands to the embedded historian.
 *
 * It lives on `globalThis` under a `Symbol.for` key, and that is not a detail:
 *
 *   - Pi evaluates an extension through jiti with `moduleCache: false`, so one process can hold
 *     several evaluations of this package. Module state written by one is invisible to another,
 *     which is why the binding seam appeared to work while the runner that actually ran was never
 *     bound.
 *   - The runner is also rebuilt per pass (`resolveContextOptionsForProject` calls
 *     `resolveHistorianFromConfig` again), so binding the instance captured when the context options
 *     were first built reaches an object the trigger no longer uses.
 *
 * One process, one registry, readable from wherever a runner happens to be constructed or run.
 */
const EMBEDDED_MODEL_REGISTRY_SLOT = Symbol.for(
	"magic-context.pi.embedded-model-registry",
);

type EmbeddedModelRegistryGlobal = typeof globalThis & {
	[EMBEDDED_MODEL_REGISTRY_SLOT]?: ModelRegistry;
};

export function readEmbeddedModelRegistry(): ModelRegistry | undefined {
	return (globalThis as EmbeddedModelRegistryGlobal)[
		EMBEDDED_MODEL_REGISTRY_SLOT
	];
}

export function writeEmbeddedModelRegistry(registry: ModelRegistry): void {
	(globalThis as EmbeddedModelRegistryGlobal)[EMBEDDED_MODEL_REGISTRY_SLOT] =
		registry;
}
