/**
 * Cross-runtime helpers that smooth over the small bun:sqlite ↔ node:sqlite
 * API differences without leaking either backend into call sites.
 */

import type { Database } from "./sqlite";

/**
 * Close a database, ignoring errors.
 *
 * bun:sqlite requires `db.close(true)` to finalize outstanding prepared
 * statements and release WAL/SHM handles; `db.close(false)` returns without
 * releasing those native resources. node:sqlite has only `db.close()` and
 * throws ("database is not open") on an already-closed handle. This helper
 * requests the Bun force-close behavior and swallows errors for both runtimes,
 * which is required by test teardown and `finally` blocks.
 */
export function closeQuietly(db: Database | null | undefined): void {
    if (!db) return;
    // Just attempt close and swallow errors. bun:sqlite has no `open` property,
    // and node:sqlite throws on an already-closed handle — both are handled by
    // the bare try/catch.
    try {
        // Bun's SQLite `true` mode finalizes outstanding prepared statements and
        // releases WAL/SHM handles. Node's db.close() ignores the extra argument
        // at runtime, so the same call works for both backends.
        (db.close as unknown as (forceClose?: boolean) => void)(true);
    } catch {
        // intentional: caller wants quiet close
    }
}
