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
    deleteChapter,
    getChapters,
    getChaptersForProject,
    getLastSealedChapterSpanEnd,
    renderChaptersBlock,
    estimateChaptersTokens,
    sealChaptersForCompartments,
    updateChapterContent,
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
    test("seals one chapter per fold, covering exactly what that fold appended", () => {
        // Two compartments is a whole fold here. The chapter boundary follows the FOLD (the
        // campaign phase edge), not an invented compartment count, so this is one chapter.
        const compartments = Array.from({ length: 2 }, (_, i) =>
            compartment(i + 1, `Title ${i + 1}`, 50),
        );
        expect(sealChaptersForCompartments(db, "session-01", compartments, "/test")).toBe(1);
        const chapters = chaptersList();
        expect(chapters).toHaveLength(1);
        expect(chapters[0].spanStartSequence).toBe(1);
        expect(chapters[0].spanEndSequence).toBe(2);
    });

    test("a fold larger than the cap is split, and the last chapter ends on the fold's end", () => {
        // One fold of 5 with a cap of 2: 2 + 2 + 1. The remainder becomes the last chapter
        // rather than staying open, so the interval is closed exactly at the fold boundary and
        // no compartment is ever covered twice.
        const compartments = Array.from({ length: 5 }, (_, i) =>
            compartment(i + 1, `Title ${i + 1}`, 50),
        );
        expect(sealChaptersForCompartments(db, "session-01", compartments, "/test", 2)).toBe(3);
        const chapters = chaptersList();
        expect(chapters.map((c) => [c.spanStartSequence, c.spanEndSequence])).toEqual([
            [1, 2],
            [3, 4],
            [5, 5],
        ]);
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

    test("a later fold becomes its own chapter, never folded into the previous one", () => {
        const first = Array.from({ length: 28 }, (_, i) =>
            compartment(i + 1, `A${i + 1}`),
        );
        sealChaptersForCompartments(db, "session-01", first, "/test");
        // A second fold of 5 is a second chapter. It must NOT extend the sealed first chapter:
        // a sealed chapter's bytes are fixed, so extending it would rewrite the m[0] prefix.
        const second = Array.from({ length: 5 }, (_, i) =>
            compartment(29 + i, `B${i + 1}`),
        );
        expect(sealChaptersForCompartments(db, "session-01", second, "/test")).toBe(1);
        const chapters = chaptersList();
        expect(chapters).toHaveLength(2);
        expect(chapters[0].spanEndSequence).toBe(28);
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
describe("player edits and removal (v93)", () => {
    /** Seal one chapter so the CRUD tests act on a row the fold really wrote. */
    function sealOne(): Chapter {
        sealChaptersForCompartments(db, "session-01", [compartment(1, "first")], "/p");
        const [chapter] = getChapters(db, "session-01");
        if (chapter === undefined) throw new Error("fixture sealed no chapter");
        return chapter;
    }

    test("the panel's read is continuity-scoped, not session-scoped", () => {
        sealChaptersForCompartments(db, "session-01", [compartment(1, "first")], "/p");
        sealChaptersForCompartments(db, "session-02", [compartment(2, "second")], "/p");
        sealChaptersForCompartments(db, "session-03", [compartment(3, "elsewhere")], "/other");
        expect(getChaptersForProject(db, "/p").map((chapter) => chapter.sessionId)).toEqual(["session-01", "session-02"]);
        expect(getChaptersForProject(db, "/other")).toHaveLength(1);
    });

    test("a sealed chapter arrives with an untouched status", () => {
        const chapter = sealOne();
        expect(chapter.status).toBe("sealed");
        expect(chapter.editedAt).toBeNull();
    });

    test("the player's text replaces the body and is recorded as the player's", () => {
        const chapter = sealOne();
        expect(updateChapterContent(db, { projectPath: "/p", chapterId: chapter.id, content: "what I remember", now: 111 })).toBe(true);

        const [updated] = getChapters(db, "session-01");
        expect(updated?.content).toBe("what I remember");
        expect(updated?.status).toBe("edited");
        expect(updated?.editedAt).toBe(111);
        // The fold's own record of what was covered does not move.
        expect(updated?.spanStartSequence).toBe(chapter.spanStartSequence);
        expect(updated?.spanEndSequence).toBe(chapter.spanEndSequence);
        expect(updated?.revision).toBe(chapter.revision + 1);
    });

    test("removal is a tombstone: the row and its span survive, and it stops rendering", () => {
        const chapter = sealOne();
        const before = renderChaptersBlock(getChapters(db, "session-01"));
        expect(before).toContain("## CHAPTERS:");

        expect(deleteChapter(db, { projectPath: "/p", chapterId: chapter.id, now: 222 })).toBe(true);

        const after = getChapters(db, "session-01");
        expect(after).toHaveLength(1);
        expect(after[0]?.status).toBe("deleted");
        expect(after[0]?.content).toBe(chapter.content);
        // Rendering drops it, and the span stays covered so a later fold cannot re-derive it.
        expect(renderChaptersBlock(after)).toBe("");
        expect(getLastSealedChapterSpanEnd(db, "session-01")).toBe(chapter.spanEndSequence);
        expect(sealChaptersForCompartments(db, "session-01", [compartment(1, "first")], "/p")).toBe(0);
    });

    test("a second removal changes nothing, and another session cannot touch the row", () => {
        const chapter = sealOne();
        expect(deleteChapter(db, { projectPath: "/other", chapterId: chapter.id, now: 1 })).toBe(false);
        expect(updateChapterContent(db, { projectPath: "/other", chapterId: chapter.id, content: "x", now: 1 })).toBe(false);
        expect(deleteChapter(db, { projectPath: "/p", chapterId: chapter.id, now: 2 })).toBe(true);
        expect(deleteChapter(db, { projectPath: "/p", chapterId: chapter.id, now: 3 })).toBe(false);
        expect(getChapters(db, "session-01")[0]?.editedAt).toBe(2);
    });

    test("the estimate counts what renders, not what the player removed", () => {
        sealChaptersForCompartments(db, "session-01", [compartment(1, "first"), compartment(2, "second")], "/p", 1);
        const all = getChapters(db, "session-01");
        expect(all).toHaveLength(2);
        const full = estimateChaptersTokens(all);
        expect(deleteChapter(db, { projectPath: "/p", chapterId: all[1]!.id, now: 5 })).toBe(true);
        expect(estimateChaptersTokens(getChapters(db, "session-01"))).toBeLessThan(full);
    });
});
