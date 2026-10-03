/**
 * Chapter rollup tests (GameBuddy AIRP fork v1).
 *
 * Contract under test:
 *   - `chapters` table created by migration v92 (fresh DB path).
 *   - A chapter is sealed once, idempotently, over the interval
 *     (last_sealed.span_end_sequence, max(sequence)] — replaying the same fold
 *     never duplicates.
 *   - `buildChapter` is deterministic: importance DESC (tiebreak sequence),
 *     top-5 titles, body holds only highlights (heading assembled at render).
 *   - `getChapters` is chronological (oldest first).
 *   - `renderChaptersBlock` is byte-stable between folds and append-only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { initializeDatabase } from "./storage-db";
import { runMigrations } from "./migrations";
import {
    buildChapter,
    getChapters,
    getLastSealedChapterSpanEnd,
    renderChaptersBlock,
    sealChaptersForCompartments,
    type Chapter,
} from "./chapter-storage";
import type { Compartment } from "./compartment-storage";

let db: Database;

beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
    // chapters is created by migration v92 (same pattern as git_commits via
    // runMigrations); production openDatabase() runs both back-to-back.
    runMigrations(db);
});

afterEach(() => {
    closeQuietly(db);
});

function compartment(
    sequence: number,
    title: string,
    importance = 50,
    createdAt = Date.now() - (100 - sequence) * 60_000,
): Compartment {
    return {
        id: sequence,
        sessionId: "session-01",
        sequence,
        startMessage: sequence,
        endMessage: sequence,
        startMessageId: `msg-${sequence}`,
        endMessageId: `msg-${sequence}`,
        title,
        content: title,
        p1: title,
        p2: title,
        p3: title,
        p4: title,
        importance,
        episodeType: null,
        legacy: 0,
        createdAt,
        rebaseStatus: "ok",
    };
}

function chaptersList(): Chapter[] {
    return getChapters(db, "session-01");
}

describe("migration v92 creates the chapters table", () => {
    test("running initializeDatabase makes chapters usable", () => {
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all() as Array<{ name: string }>;
        expect(tables.map((t) => t.name)).toContain("chapters");
        db.prepare("INSERT INTO chapters (session_id, project_path, span_start_sequence, span_end_sequence, start_date, end_date, title, content, source_compartment_ids, importance, sealed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
            "session-01",
            "/test",
            1,
            28,
            "2026-01-01",
            "2026-01-07",
            "t",
            "c",
            "[]",
            50,
            Date.now(),
            Date.now(),
        );
        expect(chaptersList()).toHaveLength(1);
    });
});

describe("sealChaptersForCompartments", () => {
    test("seals one chapter per N compartments with default N=28", () => {
        const compartments = Array.from({ length: 56 }, (_, i) =>
            compartment(i + 1, `Title ${i + 1}`, 50),
        );
        const sealed = sealChaptersForCompartments(
            db,
            "session-01",
            compartments,
            "/test",
        );
        expect(sealed).toBe(2);
        const chapters = chaptersList();
        expect(chapters).toHaveLength(2);
        expect(chapters[0].spanStartSequence).toBe(1);
        expect(chapters[0].spanEndSequence).toBe(28);
        expect(chapters[1].spanStartSequence).toBe(29);
        expect(chapters[1].spanEndSequence).toBe(56);
    });

    test("idempotent: replaying the same fold never duplicates chapters", () => {
        const compartments = Array.from({ length: 28 }, (_, i) =>
            compartment(i + 1, `Title ${i + 1}`),
        );
        expect(sealChaptersForCompartments(db, "session-01", compartments, "/test")).toBe(1);
        // Replay same fold (e.g. crash retry): interval (28, 28] is empty.
        expect(sealChaptersForCompartments(db, "session-01", compartments, "/test")).toBe(0);
        expect(chaptersList()).toHaveLength(1);
    });

    test("a partial tail below N is sealed too (seal-once, no re-derivation)", () => {
        const first = Array.from({ length: 28 }, (_, i) =>
            compartment(i + 1, `A${i + 1}`),
        );
        sealChaptersForCompartments(db, "session-01", first, "/test");
        // Second fold appends 5 more — under N=28, but all 5 must be sealed as
        // a partial chapter so the interval never re-derives.
        const second = Array.from({ length: 5 }, (_, i) =>
            compartment(29 + i, `B${i + 1}`),
        );
        expect(sealChaptersForCompartments(db, "session-01", second, "/test")).toBe(1);
        const chapters = chaptersList();
        expect(chapters).toHaveLength(2);
        expect(chapters[1].spanStartSequence).toBe(29);
        expect(chapters[1].spanEndSequence).toBe(33);
    });

    test("resumes from the last sealed span, not from the passed array length", () => {
        sealChaptersForCompartments(
            db,
            "session-01",
            Array.from({ length: 28 }, (_, i) => compartment(i + 1, `A${i + 1}`)),
            "/test",
        );
        // A caller passes only the NEW tail (5 compartments); last sealed is 28.
        const tail = Array.from({ length: 5 }, (_, i) =>
            compartment(29 + i, `B${i + 1}`),
        );
        expect(sealChaptersForCompartments(db, "session-01", tail, "/test")).toBe(1);
        expect(getLastSealedChapterSpanEnd(db, "session-01")).toBe(33);
    });

    test("is scoped by session_id", () => {
        const compartments = Array.from({ length: 28 }, (_, i) =>
            compartment(i + 1, `A${i + 1}`),
        );
        sealChaptersForCompartments(db, "session-01", compartments, "/test");
        sealChaptersForCompartments(db, "session-02", compartments, "/test");
        expect(getChapters(db, "session-01")).toHaveLength(1);
        expect(getChapters(db, "session-02")).toHaveLength(1);
    });
});

describe("buildChapter determinism", () => {
    test("picks top-5 titles by importance DESC, tiebreak sequence", () => {
        const compartments = [
            compartment(1, "lowest", 10),
            compartment(2, "highest", 99),
            compartment(3, "second", 90),
            compartment(4, "third", 80),
            compartment(5, "fourth", 70),
            compartment(6, "fifth", 60),
            compartment(7, "sixth", 50),
        ];
        const chapter = buildChapter("session-01", "/test", compartments);
        expect(chapter.content.split("; ")).toEqual([
            "highest",
            "second",
            "third",
            "fourth",
            "fifth",
        ]);
    });

    test("body holds only highlights; heading assembled at render", () => {
        const chapter = buildChapter(
            "session-01",
            "/test",
            [compartment(1, "Alpha"), compartment(2, "Beta", 90)],
        );
        // content has no heading markers, no span duplication.
        expect(chapter.content).toBe("Beta; Alpha");
        expect(chapter.title).toBe("Alpha");
        expect(chapter.spanStartSequence).toBe(1);
        expect(chapter.spanEndSequence).toBe(2);
        expect(chapter.revision).toBe(0);
    });

    test("importance is the mean clamped to 1..100", () => {
        const chapter = buildChapter(
            "session-01",
            "/test",
            [compartment(1, "A", 100), compartment(2, "B", 80)],
        );
        expect(chapter.importance).toBe(90);
        const low = buildChapter(
            "session-01",
            "/test",
            [compartment(1, "A", 0), compartment(2, "B", 0)],
        );
        expect(low.importance).toBe(1);
    });

    test("sealedAt/createdAt are set (fold time)", () => {
        const chapter = buildChapter("session-01", "/test", [compartment(1, "A")]);
        expect(chapter.sealedAt).toBeGreaterThan(0);
        expect(chapter.createdAt).toBe(chapter.sealedAt);
    });
});

describe("renderChaptersBlock", () => {
    test("byte-stable and chronological", () => {
        const compartments1 = Array.from({ length: 28 }, (_, i) =>
            compartment(i + 1, `C${i + 1}`, 50, Date.now() - (280 - i) * 60_000),
        );
        sealChaptersForCompartments(db, "session-01", compartments1, "/test");
        const block1 = renderChaptersBlock(chaptersList());

        // Append a second chapter (later fold).
        const compartments2 = Array.from({ length: 20 }, (_, i) =>
            compartment(29 + i, `D${i + 1}`, 50, Date.now() - (80 - i) * 60_000),
        );
        sealChaptersForCompartments(db, "session-01", compartments2, "/test");
        const block2 = renderChaptersBlock(chaptersList());

        // Chapter 1's bytes are a prefix of the full block (append-only).
        expect(block2.startsWith(block1)).toBe(true);
        expect(block2.split("\n\n")).toHaveLength(2);
        expect(block1.split("\n\n")[0]).toContain("## CHAPTERS:");
    });

    test("empty when no chapters", () => {
        expect(renderChaptersBlock([])).toBe("");
    });

    test("renders heading from structured fields, not duplicated body", () => {
        const chapter = buildChapter("session-01", "/test", [
            compartment(1, "Alpha", 60),
            compartment(2, "Beta", 90),
        ]);
        const rendered = renderChaptersBlock([chapter]);
        // heading contains "## CHAPTERS:", the title, and the span.
        expect(rendered).toContain("## CHAPTERS:");
        expect(rendered).toContain("Alpha");
        // The span suffix is rendered once, from structured fields only — it is
        // not baked into the body ("Beta; Alpha" has no heading/span text).
        expect(rendered).toContain("Alpha ("); // heading title + span
        expect(chapter.content).toBe("Beta; Alpha"); // body is highlight-only
    });
});