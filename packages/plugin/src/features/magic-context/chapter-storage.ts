// Chapter rollup storage for the GameBuddy fork (v1).
//
// Chapters are immutable narrative-level summaries over ranges of base
// compartments. They exist to give m[0] a permanent coarse map of the whole
// conversation/game history: without them, archived (P5) compartments render
// as empty strings and far-past experience vanishes from the prompt entirely
// (the "goldfish memory" failure).
//
// Why this is a layer ABOVE the native decay curve rather than a rival to it:
// the curve already renders a budget bounded history (its own docs call
// `history_budget_percentage` "a budget for history that remains in the prompt"
// and say the oldest low-priority compartments "can be omitted"). What it
// cannot do is keep a trace of what it omitted, because the boundary moves with
// age, importance and pressure. Measured on this very module (age in
// compartments, at the pressure floor of 0.1): importance 20 -> 270, 50 -> 621,
// 80 -> 1426. For a game save at roughly 30 compartments per in-game day that is
// 9 / 21 / 48 in-game days of history still present, after which the earliest
// days are gone from m[0] no matter how large the window is. Chapters are the
// constant-budget answer to that: sealed once, then never rewritten, so they
// cost a stable number of tokens per chapter instead of a growing share.
//
// v1 invariants (see design/architecture/airp-memory-evolution-architecture.md):
//   - A chapter is sealed once, inside the SAME transaction that appends the
//     compartments it summarizes (HARD fold), and is NEVER rewritten or
//     deleted afterwards. Only `revision` may change, and only via the v2
//     Dreamer quality pass, which runs outside the fold and before sealing.
//   - Rendering is chronological (oldest first) and append-only; the chapter
//     block sits at the head of the history block so the prefix cache sees a
//     stable byte prefix across folds.
//   - Chapters never decay: they have no p1-p4 tier columns and are not
//     subject to the decay curve. The single `content` text is the one that
//     renders, forever.
//   - The rollup boundary is a continuous sequence interval
//     (last_sealed.span_end_sequence, max(sequence)], NOT an "archived"
//     state: the compartments table has no archived column, P5 is a render-
//     time artifact of the decay curve.
//   - The interval is closed at a HARD fold and by DEFAULT covers exactly the
//     compartments that fold appended (one chapter per fold, see
//     chaptersPerSeal). No invented compartment count drives this: the fold is
//     the campaign phase boundary, and its compartments are equal by
//     construction, so importance cannot bias which ones get the fast half-life.
import { formatDate } from "../../hooks/magic-context/temporal-awareness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import type { Compartment } from "./compartment-storage";

/**
 * Upper bound on how many base compartments one chapter may summarize.
 *
 * Not a target and not a partition size. The default seals one chapter per HARD
 * fold (the whole appended interval), which is what the campaign's own phase
 * boundaries produce, and which keeps a chapter's compartments equal in age so
 * importance cannot bias which of them gets the fast half-life. This ceiling
 * exists only so a single unusually long fold cannot seal a chapter that
 * swallows many phases; when it divides, the call still closes the interval at
 * the fold's end (the last chapter covers the remainder), so every sealed
 * chapter boundary stays on a phase edge.
 */
export const MAX_CHAPTER_COMPARTMENTS = 4096;

/** Default cap on sealed chapter size; see MAX_CHAPTER_COMPARTMENTS. */
export const DEFAULT_CHAPTER_COMPARTMENT_CAP = MAX_CHAPTER_COMPARTMENTS;

/** Default total chapter budget in tokens; only a warning threshold, never a truncation trigger. */
export const DEFAULT_CHAPTER_BUDGET_TOKENS = 4096;

export interface Chapter {
    id: number;
    sessionId: string;
    projectPath: string;
    spanStartSequence: number;
    spanEndSequence: number;
    startDate: string;
    endDate: string;
    title: string;
    /** Sealed, immutable v1 body; v2 Dreamer polish rewrites this pre-seal only. */
    content: string;
    sourceCompartmentIds: number[];
    /** Generation-time sort input only; not a runtime decay signal. */
    importance: number;
    sealedAt: number;
    revision: number;
    createdAt: number;
}

interface ChapterRow {
    id: number;
    session_id: string;
    project_path: string;
    span_start_sequence: number;
    span_end_sequence: number;
    start_date: string;
    end_date: string;
    title: string;
    content: string;
    source_compartment_ids: string;
    importance: number;
    sealed_at: number;
    revision: number;
    created_at: number;
}

function isChapterRow(value: unknown): value is ChapterRow {
    if (typeof value !== "object" || value === null) return false;
    const row = value as Record<string, unknown>;
    return (
        typeof row.id === "number" &&
        typeof row.session_id === "string" &&
        typeof row.project_path === "string" &&
        typeof row.span_start_sequence === "number" &&
        typeof row.span_end_sequence === "number" &&
        typeof row.start_date === "string" &&
        typeof row.end_date === "string" &&
        typeof row.title === "string" &&
        typeof row.content === "string" &&
        typeof row.source_compartment_ids === "string" &&
        typeof row.sealed_at === "number" &&
        typeof row.created_at === "number"
    );
}

function toChapter(row: ChapterRow): Chapter {
    let sourceCompartmentIds: number[] = [];
    try {
        const parsed: unknown = JSON.parse(row.source_compartment_ids);
        if (
            Array.isArray(parsed) &&
            parsed.every((entry) => typeof entry === "number")
        )
            sourceCompartmentIds = parsed;
    } catch {
        // Malformed legacy row: keep empty list; the chapter body is what renders.
    }
    return {
        id: row.id,
        sessionId: row.session_id,
        projectPath: row.project_path,
        spanStartSequence: row.span_start_sequence,
        spanEndSequence: row.span_end_sequence,
        startDate: row.start_date,
        endDate: row.end_date,
        title: row.title,
        content: row.content,
        sourceCompartmentIds,
        importance: row.importance,
        sealedAt: row.sealed_at,
        revision: row.revision,
        createdAt: row.created_at,
    };
}

/** All chapters for a session, chronological (oldest first). */
export function getChapters(db: Database, sessionId: string): Chapter[] {
    const rows = db
        .prepare(
            "SELECT * FROM chapters WHERE session_id = ? ORDER BY span_start_sequence ASC, id ASC",
        )
        .all(sessionId)
        .filter(isChapterRow);
    return rows.map(toChapter);
}

/** Highest span_end_sequence any chapter covers for this session (0 when none). */
export function getLastSealedChapterSpanEnd(
    db: Database,
    sessionId: string,
): number {
    const row = db
        .prepare(
            "SELECT MAX(span_end_sequence) AS max_end FROM chapters WHERE session_id = ?",
        )
        .get(sessionId) as { max_end: number | null } | null;
    return row?.max_end ?? 0;
}

const insertChapterStatement = new WeakMap<Database, PreparedStatement>();

function getInsertChapterStatement(db: Database): PreparedStatement {
    let stmt = insertChapterStatement.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO chapters (session_id, project_path, span_start_sequence, span_end_sequence, start_date, end_date, title, content, source_compartment_ids, importance, sealed_at, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
        );
        insertChapterStatement.set(db, stmt);
    }
    return stmt;
}

/**
 * Seal chapters for the appended compartment range, INSIDE the caller's
 * transaction. Idempotent: only spans after the last sealed chapter are
 * considered, so replaying the same fold never duplicates chapters.
 *
 * @param compartments the compartments appended by this fold, chronological.
 * @param projectPath project identity for cross-session aggregation (v2); v1
 *   scopes strictly by session_id but stores the path for future use.
 * @param chapterCompartmentCap upper bound on compartments per chapter; see
 *   MAX_CHAPTER_COMPARTMENTS. Only a pathological fold reaches it.
 */
export function sealChaptersForCompartments(
    db: Database,
    sessionId: string,
    compartments: readonly Compartment[],
    projectPath: string,
    chapterCompartmentCap: number = DEFAULT_CHAPTER_COMPARTMENT_CAP,
): number {
    if (compartments.length === 0) return 0;
    const cap = Number.isFinite(chapterCompartmentCap) && chapterCompartmentCap >= 1 ? Math.floor(chapterCompartmentCap) : DEFAULT_CHAPTER_COMPARTMENT_CAP;
    const lastSealed = getLastSealedChapterSpanEnd(db, sessionId);
    // Only the interval (lastSealed, max sequence] is new.
    const candidateMax = compartments[compartments.length - 1]?.sequence ?? 0;
    if (candidateMax <= lastSealed) return 0;

    const all = compartments.filter((c) => c.sequence > lastSealed);
    const chapters: Chapter[] = [];
    // Walk to the LAST full cap boundary, then close on the remainder, so the
    // sealed ranges always end exactly at this fold's end (a phase edge) and
    // every compartment is covered exactly once.
    const fullEnd = Math.floor(all.length / cap) * cap;
    for (let start = 0; start < fullEnd; start += cap) {
        chapters.push(buildChapter(sessionId, projectPath, all.slice(start, start + cap)));
    }
    if (fullEnd < all.length) {
        chapters.push(buildChapter(sessionId, projectPath, all.slice(fullEnd)));
    }
    const stmt = getInsertChapterStatement(db);
    for (const chapter of chapters) {
        stmt.run(
            sessionId,
            chapter.projectPath,
            chapter.spanStartSequence,
            chapter.spanEndSequence,
            chapter.startDate,
            chapter.endDate,
            chapter.title,
            chapter.content,
            JSON.stringify(chapter.sourceCompartmentIds),
            chapter.importance,
            chapter.sealedAt,
            chapter.createdAt,
        );
    }
    return chapters.length;
}

/** Deterministic v1 chapter body: no model, no prose. `content` holds ONLY
 *  the body (highlight titles joined); the `## CHAPTERS:` heading plus the
 *  title/span are assembled at render time from structured fields, so a v2
 *  Dreamer polish of `content` never changes the heading bytes. */
export function buildChapter(
    sessionId: string,
    projectPath: string,
    compartments: readonly Compartment[],
): Chapter {
    const sealedAt = Date.now();
    const first = compartments[0];
    const last = compartments[compartments.length - 1];
    // Highlight titles by descending importance (deterministic tiebreak by
    // sequence so replay is byte-stable).
    const highlights = [...compartments]
        .sort((a, b) => b.importance - a.importance || a.sequence - b.sequence)
        .slice(0, 5)
        .map((c) => c.title)
        .filter((t) => t.length > 0);
    const title =
        compartments[0]?.title && compartments[0]?.title.length > 0
            ? compartments[0].title
            : `Compartments ${first.sequence}-${last.sequence}`;
    // Body is only the highlights; the heading (title + span) is rendered from
    // structured fields, never duplicated into content.
    const content = highlights.join("; ");
    return {
        id: 0,
        sessionId,
        projectPath,
        spanStartSequence: first.sequence,
        spanEndSequence: last.sequence,
        startDate: formatDate(first.createdAt),
        endDate: formatDate(last.createdAt),
        title,
        content,
        sourceCompartmentIds: compartments.map((c) => c.id),
        importance: Math.max(
            1,
            Math.min(
                100,
                Math.round(
                    compartments.reduce(
                        (sum, c) => sum + (c.importance ?? 50),
                        0,
                    ) / compartments.length,
                ),
            ),
        ),
        sealedAt,
        revision: 0,
        createdAt: sealedAt,
    };
}

/**
 * Render the chapters block for a session: chronological, append-only, one
 * `## CHAPTERS:` line per chapter, styled like the decay-render headings so
 * the m[0] history block stays internally consistent. Empty when there are
 * no chapters. A chapter's body is sealed and immutable; the block is the
 * same bytes on every pass between folds.
 */
export function renderChaptersBlock(chapters: readonly Chapter[]): string {
    if (chapters.length === 0) return "";
    return chapters
        .map((chapter) => {
            const span =
                chapter.startDate === chapter.endDate
                    ? chapter.startDate
                    : `${chapter.startDate}→${chapter.endDate}`;
            const body = guardChapterBody(chapter.content);
            return `## CHAPTERS: ${sanitizeChapterTitle(chapter.title)} (${sanitizeChapterTitle(span)}) · ${body}`;
        })
        .join("\n\n");
}

function sanitizeChapterTitle(value: string): string {
    return value
        .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function guardChapterBody(value: string): string {
    // A rendered body cannot open a new compartment; indent heading-like lines.
    return value.replace(/^## /gm, " ## ");
}

/** Total rendered chapters token estimate (cheap heuristic; warning only). */
export function estimateChaptersTokens(chapters: readonly Chapter[]): number {
    return (
        chapters.reduce((sum, c) => sum + c.content.length + c.title.length, 0) / 4
    );
}