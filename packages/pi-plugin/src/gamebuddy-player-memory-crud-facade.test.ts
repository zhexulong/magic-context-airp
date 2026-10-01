import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCommandFacade } from "@magic-context/core/features/magic-context/memory/command-facade";
import { openDatabaseAsync } from "@magic-context/core/features/magic-context/storage-db";
import { createGameBuddyPlayerMemoryCrudFacade } from "./gamebuddy-player-memory-crud-facade";
import { resolveGameBuddyMemoryProjectPath, validateMemoryProfileBinding } from "./gamebuddy-player-memory-read-projection";
import { setDeclaredProjectIdentity, _resetHarnessForTesting } from "@magic-context/core/shared/harness";

const continuityId = "continuity_01";
const defaultProfile = {
	profileId: "profile_01",
	profileRevision: 1,
};
let root: string | undefined;

afterEach(async () => {
	if (root !== undefined)
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 4,
			retryDelay: 250,
		}).catch(() => undefined);
	root = undefined;
	_resetHarnessForTesting();
});

describe("resolveGameBuddyMemoryProjectPath with a declared partition", () => {
	test("is idempotent: the declared full path is returned verbatim", () => {
		// The render side declares the full path (setDeclaredProjectIdentity). The
		// management CRUD side runs in the same process and must write under that
		// SAME path, not re-wrap it. Before the fix this returned
		// `gamebuddy:gamebuddy:<identity>:continuity:<id>:continuity:<id>` and the
		// render session could never meet the written rows.
		const declared = resolveGameBuddyMemoryProjectPath("C:/tmp/runtime", "continuity_x");
		setDeclaredProjectIdentity(declared);
		expect(resolveGameBuddyMemoryProjectPath("C:/tmp/runtime", "continuity_x")).toBe(declared);
		// Even a different continuity id cannot change the already-declared path;
		// the declaration is boot-time locked.
		expect(resolveGameBuddyMemoryProjectPath("C:/tmp/runtime", "continuity_y")).toBe(declared);
	});
	test("writes land under the declared path, not a doubled one", async () => {
		root = await mkdtemp(join(tmpdir(), "gamebuddy-memory-crud-declared-"));
		const before = resolveGameBuddyMemoryProjectPath(root, continuityId);
		setDeclaredProjectIdentity(before);
		const facade = createGameBuddyPlayerMemoryCrudFacade({
			continuityId,
			runtimeCwd: root,
			...defaultProfile,
		});
		const created = await facade.create({
			continuityId,
			content: "declared partition row",
			...defaultProfile,
		});
		expect(created.content).toBe("declared partition row");
		// The durable store row must be scoped to the single-wrapped declared path.
		const { openDatabaseAsync: open } = await import("@magic-context/core/features/magic-context/storage-db");
		const db = await open(join(root, "data", "cortexkit", "magic-context", "context.db"));
		const row = db
			.prepare("SELECT project_path FROM memories WHERE content = ?")
			.get("declared partition row") as { project_path: string } | undefined;
		expect(row?.project_path).toBe(before);
	});
});

describe("GameBuddy player Memory CRUD facade", () => {
	test("is continuity-bound, writes through vendor ownership, and rereads each mutation", async () => {
		root = await mkdtemp(join(tmpdir(), "gamebuddy-memory-crud-"));
		const facade = createGameBuddyPlayerMemoryCrudFacade({
			continuityId,
			runtimeCwd: root,
			...defaultProfile,
		});

		const created = await facade.create({
			continuityId,
			content: "The farmer likes blueberries.",
			...defaultProfile,
		});
		expect(created.content).toBe("The farmer likes blueberries.");
		expect(created.category).toBe("semantic");
		expect(created.status).toBe("active");

		const updated = await facade.update({
			continuityId,
			stateToken: created.stateToken,
			content: "The farmer prefers strawberries.",
			...defaultProfile,
		});
		expect(updated.content).toBe("The farmer prefers strawberries.");
		expect(updated.stateToken).not.toBe(created.stateToken);

		const archived = await facade.archive({
			continuityId,
			stateToken: updated.stateToken,
			...defaultProfile,
		});
		expect(archived.status).toBe("archived");

		const entries = await facade.listMemories({
			continuityId,
			...defaultProfile,
		});
		expect(entries).toHaveLength(1);
		expect(entries[0]?.content).toBe("The farmer prefers strawberries.");
		expect(entries[0]?.status).toBe("archived");
		await expect(
			facade.listMemories({ continuityId: "other", ...defaultProfile }),
		).rejects.toThrow("gamebuddy_memory_continuity_mismatch");
	});

	test("isolates continuities and omits unrelated vendor categories from the player projection", async () => {
		root = await mkdtemp(join(tmpdir(), "gamebuddy-memory-crud-isolation-"));
		const databasePath = join(
			root,
			"data",
			"cortexkit",
			"magic-context",
			"context.db",
		);
		const db = await openDatabaseAsync(databasePath);
		expect(db).toBeTruthy();
		const commands = new MemoryCommandFacade(db!);
		const projectPath = resolveGameBuddyMemoryProjectPath(root, continuityId);
		commands.create({
			projectPath,
			category: "PROJECT_RULES",
			content:
				"This non-player category must not make the safe projection fail.",
			sourceType: "user",
			actor: { principal: "player_direct", delegated: false },
		});
		const first = createGameBuddyPlayerMemoryCrudFacade({
			continuityId,
			runtimeCwd: root,
			...defaultProfile,
		});
		const second = createGameBuddyPlayerMemoryCrudFacade({
			continuityId: "continuity_02",
			runtimeCwd: root,
			...defaultProfile,
		});

		await first.create({
			continuityId,
			content: "Only the first continuity may see this.",
			...defaultProfile,
		});
		expect(
			await first.listMemories({ continuityId, ...defaultProfile }),
		).toMatchObject([{ content: "Only the first continuity may see this." }]);
		expect(
			await second.listMemories({
				continuityId: "continuity_02",
				...defaultProfile,
			}),
		).toEqual([]);
	});

	test("rejects a second write using the stale vendor state token", async () => {
		root = await mkdtemp(join(tmpdir(), "gamebuddy-memory-crud-cas-"));
		const facade = createGameBuddyPlayerMemoryCrudFacade({
			continuityId,
			runtimeCwd: root,
			...defaultProfile,
		});
		const created = await facade.create({
			continuityId,
			content: "Original",
			...defaultProfile,
		});
		await facade.update({
			continuityId,
			stateToken: created.stateToken,
			content: "First update",
			...defaultProfile,
		});
		await expect(
			facade.update({
				continuityId,
				stateToken: created.stateToken,
				content: "Stale second update",
				...defaultProfile,
			}),
		).rejects.toThrow(/stale|not found/i);
		const rows = await facade.listMemories({ continuityId, ...defaultProfile });
		expect(rows).toMatchObject([{ content: "First update" }]);
	});

	test("validates profile binding and rejects mismatched profile operations", async () => {
		root = await mkdtemp(join(tmpdir(), "gamebuddy-memory-crud-profile-"));
		const validProfile = {
			continuityId,
			runtimeCwd: root,
			profileId: "profile_01",
			profileRevision: 2,
		};
		const facade = createGameBuddyPlayerMemoryCrudFacade(validProfile);

		// Mismatched profileId throws
		await expect(
			facade.create({
				continuityId,
				content: "Test",
				profileId: "mismatched_profile",
				profileRevision: 2,
			}),
		).rejects.toThrow("gamebuddy_memory_profile_mismatch");

		// Mismatched profileRevision throws
		await expect(
			facade.create({
				continuityId,
				content: "Test",
				profileId: "profile_01",
				profileRevision: 99,
			}),
		).rejects.toThrow("gamebuddy_memory_profile_mismatch");

  		// The D-02 owner decision removed profileCanonicalHash from ordinary
  		// Memory CRUD binding: the facade no longer requires or matches it.
  		await expect(
  			facade.create({
  				continuityId,
  				content: "Test",
  				profileId: "profile_01",
  				profileRevision: 2,
  			}),
  		).resolves.toBeTruthy();

		// Matching profile succeeds
		const created = await facade.create({
			continuityId,
			content: "Profile bound memory",
			profileId: "profile_01",
			profileRevision: 2,
		});
		expect(created.content).toBe("Profile bound memory");

		// Mismatched profile read throws
		await expect(
			facade.listMemories({
				continuityId,
				profileId: "wrong",
				profileRevision: 2,
			}),
		).rejects.toThrow("gamebuddy_memory_profile_mismatch");

		// Missing profile fields in binding throws
		expect(() =>
			createGameBuddyPlayerMemoryCrudFacade({
				continuityId,
				runtimeCwd: root!,
				profileId: "",
				profileRevision: 1,
			}),
		).toThrow("invalid_memory_profile_binding");
	});
});
