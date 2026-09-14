export {
  type GameBuddyPlayerMemoryCrudFacade,
  createGameBuddyPlayerMemoryCrudFacade,
} from "../gamebuddy-player-memory-crud-facade";

export {
  type GameBuddyPlayerMemoryReadProjection,
  type GameBuddyPlayerMemoryReadView,
  createGameBuddyPlayerMemoryReadProjection,
  resolveGameBuddyMemoryProjectPath,
} from "../gamebuddy-player-memory-read-projection";

import type { GameBuddyPlayerMemoryReadView } from "../gamebuddy-player-memory-read-projection";

export type GameBuddyMemoryCategory = GameBuddyPlayerMemoryReadView["category"];
export type GameBuddyMemoryStatus = GameBuddyPlayerMemoryReadView["status"];
export type GameBuddyMemoryView = GameBuddyPlayerMemoryReadView;
