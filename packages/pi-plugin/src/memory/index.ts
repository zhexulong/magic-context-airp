export {
	createGameBuddyPlayerMemoryCrudFacade,
	type GameBuddyPlayerMemoryCrudFacade,
	type GameBuddyPlayerMemoryProfileBinding,
	type GameBuddyPlayerMemoryReadInput,
} from "../gamebuddy-player-memory-crud-facade";

export {
	assertMemoryProfileMatch,
	createGameBuddyPlayerMemoryReadProjection,
	type GameBuddyPlayerMemoryReadProjection,
	type GameBuddyPlayerMemoryReadView,
	resolveGameBuddyMemoryProjectPath,
	validateMemoryProfileBinding,
} from "../gamebuddy-player-memory-read-projection";

import type { GameBuddyPlayerMemoryReadView } from "../gamebuddy-player-memory-read-projection";

export type GameBuddyMemoryCategory = GameBuddyPlayerMemoryReadView["category"];
export type GameBuddyMemoryStatus = GameBuddyPlayerMemoryReadView["status"];
export type GameBuddyMemoryView = GameBuddyPlayerMemoryReadView;

// The render-side partition declaration. A host that owns its session root must
// declare the same project identity the management CRUD facade resolves
// (`gamebuddy:<project>:continuity:<id>`), otherwise the render heuristic walks
// out of the runtime root and reads a different (usually empty) partition - which
// is the L2 assembly failure the memory loop measured. The declaration is
// boot-time and locked, exactly like setHarness.
export {
	getDeclaredProjectIdentity,
	setDeclaredProjectIdentity,
} from "@magic-context/core/shared/harness";
