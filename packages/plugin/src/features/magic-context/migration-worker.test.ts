import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { __setMigrationWorkerEntryForTests } from "./migration-worker-client";
import {
    __getMainThreadMigrationBodyCountForTests,
    FORK_MIGRATIONS,
    LATEST_MIGRATION_VERSION,
    MIGRATIONS,
} from "./migrations";
import {
    closeDatabase,
    getPersistedSchemaVersion,
    openDatabase,
    openDatabaseAsync,
} from "./storage-db";

const LATEST = LATEST_MIGRATION_VERSION;

/** The upstream lane version a store on disk holds, ignoring the fork's rows above the floor. */
function persistedVersion(dbPath: string): number {
    const db = new Database(dbPath);
    try {
        return getPersistedSchemaVersion(db);
    } finally {
        closeQuietly(db);
    }
}

describe("startup migrations run on a worker thread", () => {
    let root: string;

    beforeEach(() => {
        root = createTestTempDirFromPath(join(tmpdir(), "migration-worker-"));
        closeDatabase();
    });

    afterEach(() => {
        __setMigrationWorkerEntryForTests(null);
        closeDatabase();
        rmSync(root, { recursive: true, force: true });
    });

    test("a startup open applies every migration without running a migration body on the main thread", async () => {
        const dbPath = join(root, "context.db");
        const before = __getMainThreadMigrationBodyCountForTests();

        const db = await openDatabaseAsync({ dbPath });

        expect(db).not.toBeNull();
        expect(persistedVersion(dbPath)).toBe(LATEST);
        expect(__getMainThreadMigrationBodyCountForTests()).toBe(before);
    });

    test("the main-thread counter does see the synchronous open path, which still migrates in place", () => {
        // Without this control the test above would also pass if the counter
        // never counted anything.
        const dbPath = join(root, "sync.db");
        const before = __getMainThreadMigrationBodyCountForTests();

        expect(openDatabase(dbPath)).not.toBeNull();

        // The runner walks the upstream lane and then the fork's, so the body count is
        // both lengths: the fork's v10001/v10002 run here too.
        expect(__getMainThreadMigrationBodyCountForTests() - before).toBe(
            MIGRATIONS.length + FORK_MIGRATIONS.length,
        );
    });

    test("a current database starts no worker", async () => {
        const dbPath = join(root, "context.db");
        expect(await openDatabaseAsync({ dbPath })).not.toBeNull();
        closeDatabase();
        // A missing or failed worker must reject a pending upgrade, but a current
        // store needs no worker and must remain usable.
        const marker = join(root, "started.marker");
        const probe = join(root, "probe-worker.mjs");
        writeFileSync(
            probe,
            `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x"); import { parentPort } from "node:worker_threads"; parentPort.postMessage({ type: "ready" }); parentPort.postMessage({ type: "failed", message: "must not run" });`,
        );
        __setMigrationWorkerEntryForTests(pathToFileURL(probe));

        expect(await openDatabaseAsync({ dbPath })).not.toBeNull();
        expect(await Bun.file(marker).exists()).toBe(false);
    });

    test("a migration failure reported by the worker fails the open closed with its message", async () => {
        const dbPath = join(root, "context.db");
        const failing = join(root, "failing-worker.mjs");
        writeFileSync(
            failing,
            `import { parentPort } from "node:worker_threads"; parentPort.postMessage({ type: "ready" }); parentPort.postMessage({ type: "failed", message: "Migration v94 failed: disk I/O error. Database may need manual repair." });`,
        );
        __setMigrationWorkerEntryForTests(pathToFileURL(failing));

        await expect(openDatabaseAsync({ dbPath })).rejects.toThrow(
            "storage unavailable: Migration v94 failed: disk I/O error",
        );
    });

    test("a worker that cannot load refuses pending v95 without a main-thread fallback", async () => {
        const dbPath = join(root, "context.db");
        expect(openDatabase(dbPath)).not.toBeNull();
        closeDatabase();
        const setup = new Database(dbPath);
        setup.exec(
            "DELETE FROM schema_migrations WHERE version=95; DROP TABLE git_commit_fts_rowid_map",
        );
        setup.close();
        __setMigrationWorkerEntryForTests(pathToFileURL(join(root, "missing-worker.mjs")));
        const before = __getMainThreadMigrationBodyCountForTests();

        await expect(openDatabaseAsync({ dbPath })).rejects.toThrow(
            "the migration worker could not start",
        );

        expect(persistedVersion(dbPath)).toBe(94);
        expect(__getMainThreadMigrationBodyCountForTests()).toBe(before);
    });

    test("a worker constructor failure names the cause and repair action without migrating", async () => {
        __setMigrationWorkerEntryForTests(new URL("https://invalid.test/worker.mjs"));
        const before = __getMainThreadMigrationBodyCountForTests();
        await expect(openDatabaseAsync({ dbPath: join(root, "constructor.db") })).rejects.toThrow(
            "reinstall or rebuild the plugin",
        );
        expect(__getMainThreadMigrationBodyCountForTests()).toBe(before);
    });

    test("a worker exiting before ready fails closed instead of migrating on the host", async () => {
        const entry = join(root, "early-exit.mjs");
        writeFileSync(entry, "process.exit(17)");
        __setMigrationWorkerEntryForTests(pathToFileURL(entry));
        const before = __getMainThreadMigrationBodyCountForTests();
        await expect(openDatabaseAsync({ dbPath: join(root, "exit.db") })).rejects.toThrow(
            "exited with code 17 before loading",
        );
        expect(__getMainThreadMigrationBodyCountForTests()).toBe(before);
    });

    test("a worker reporting completion before ready cannot authorize storage initialization", async () => {
        const entry = join(root, "premature-done.mjs");
        writeFileSync(
            entry,
            `import {parentPort} from "node:worker_threads"; parentPort.postMessage({type:"done"});`,
        );
        __setMigrationWorkerEntryForTests(pathToFileURL(entry));
        const before = __getMainThreadMigrationBodyCountForTests();
        await expect(openDatabaseAsync({ dbPath: join(root, "premature.db") })).rejects.toThrow(
            "reported completion before ready",
        );
        expect(__getMainThreadMigrationBodyCountForTests()).toBe(before);
    });

    test("an incomplete worker cannot cause the async opener to run pending bodies", async () => {
        const entry = join(root, "incomplete.mjs");
        writeFileSync(
            entry,
            `import {parentPort} from "node:worker_threads"; parentPort.postMessage({type:"ready"}); parentPort.postMessage({type:"done"});`,
        );
        __setMigrationWorkerEntryForTests(pathToFileURL(entry));
        const before = __getMainThreadMigrationBodyCountForTests();
        await expect(openDatabaseAsync({ dbPath: join(root, "incomplete.db") })).rejects.toThrow(
            "did not complete the pending migration",
        );
        expect(__getMainThreadMigrationBodyCountForTests()).toBe(before);
    });

    test("the async opener refuses in-memory migrations; only the explicit sync path owns them", async () => {
        const literalFile = join(process.cwd(), ":memory:");
        expect(existsSync(literalFile)).toBe(false);
        const before = __getMainThreadMigrationBodyCountForTests();
        await expect(openDatabaseAsync(":memory:")).rejects.toThrow(
            "use the explicit synchronous opener",
        );
        expect(__getMainThreadMigrationBodyCountForTests()).toBe(before);
        expect(existsSync(literalFile)).toBe(false);
    });

    test("a synchronous open of a database still being migrated is refused instead of migrating it", async () => {
        const dbPath = join(root, "context.db");
        const opening = openDatabaseAsync({ dbPath });
        const before = __getMainThreadMigrationBodyCountForTests();

        expect(openDatabase(dbPath)).toBeNull();

        expect(__getMainThreadMigrationBodyCountForTests()).toBe(before);
        expect(await opening).not.toBeNull();
        // Once the startup open has finished, the synchronous path reuses its handle.
        expect(openDatabase(dbPath)).not.toBeNull();
    });
});
