const SYSTEM_DIRECTIVE_PREFIX = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT";

/**
 * The marker a host puts on a machine-authored delivery so it is not mistaken for a human utterance.
 *
 * A host may deliver runtime facts through the same user turn a person types into (`sendUserMessage`). Those
 * messages are structurally `role: "user"` with non-empty text, which is all `hasMeaningfulUserText` used to
 * check - so a protected tail sized in "user turns" counted them as things a player said.
 *
 * GameBuddy measured the consequence on 2026-10-27: with batches bounded at 120KB, the five-turn protected tail
 * alone was ~600KB (~150k tokens) against a declared 131,072 window, and the historian's chunk boundary pinned
 * to the last such batch, so folding could never reduce what was actually filling the context.
 *
 * The field is read, not guessed: a host that emits one of these is declaring the message is machine-delivered.
 * An unknown shape keeps the old behaviour (counts as user text), because silently ignoring a real utterance is
 * worse than over-protecting a synthetic one.
 */
const HOST_SYNTHESIZED_DELIVERY_KINDS = new Set(["gamebuddy_fact_batch"]);

function isHostSynthesizedDelivery(text: string): boolean {
    const head = text.trimStart();
    if (!head.startsWith("{")) return false;
    try {
        const parsed: unknown = JSON.parse(head);
        if (parsed === null || typeof parsed !== "object") return false;
        const kind = (parsed as Record<string, unknown>).kind;
        return typeof kind === "string" && HOST_SYNTHESIZED_DELIVERY_KINDS.has(kind);
    } catch {
        return false;
    }
}

export function isSystemDirective(text: string): boolean {
    return text.trimStart().startsWith(SYSTEM_DIRECTIVE_PREFIX);
}

export function isHostSynthesizedDeliveryText(text: string): boolean {
    return isHostSynthesizedDelivery(text);
}

export function removeSystemReminders(text: string): string {
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
}
