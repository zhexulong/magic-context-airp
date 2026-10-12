# Reflection (`reflect`) outcome plan

Status: **plan recorded, run not performed — every metric below is UNVERIFIED.**
Owner: memory. Authority: `design/architecture/historian-prompt-rubric.md`, section "V2
(reflection): what it inherits, and how its rubric shows improvement".

This file is the V2 outcome plan for the dreamer `reflect` task. It exists because the
reflection changes *what the companion keeps*, and "the task runs and writes a row" is a
plumbing claim, not a quality claim. The reflection is not measured by the memory live
loop today: that loop measures the historian fold, the chapter rollup and the rubric over
the compartments a fold wrote, and it schedules no dreamer task. The plan below is
therefore written first, and its numbers are empty until a paired run fills them.

## The one variable

| Arm | Task set |
|---|---|
| baseline | every canonical dreamer task except `reflect` (its default schedule is `""`) |
| candidate | the same set with `reflect` scheduled |

Everything else is held: same fixture, same provider, same model, same generation, same
instrument. The prompt is switched the way every other memory prompt is switched — by
editing `packages/plugin/src/hooks/magic-context/reflect-prompt.source.md` and
regenerating, never by editing a built bundle.

## Metrics that can move either way

| # | Metric | Direction that counts as improvement | Threshold | Where it is read |
|---|---|---|---|---|
| 1 | Relationship-milestone recall on a later turn | up | candidate answers at least one more of the fixture's `N>=2` milestone probes from memory than baseline (`+1` correct recall, no new wrong answer) | the loop's needle/probe verdicts on the probe turn |
| 2 | m[0] token cost | bounded | candidate m[0] is at most `+600` tokens and at most `+10%` of baseline m[0] — reflected lines land in the ordinary memory block, which the injection budget already caps | the loop report's m[0] measurement for both arms |
| 3 | Prefix-cache revisions | never up | candidate revision count `<=` baseline revision count; a single new revision source fails the pair | the run's cache-namespace / prompt-concatenation revision records |
| 4 | Promotion of model inference | `0` | no written row asserts an inferred trait, mood, preference or relationship interpretation as something the player said | the written rows of the candidate arm, read from Magic Context's own database |

## Acceptance rule

The change counts as an improvement only when **at least one** metric above moves by its
threshold **and no invariant regresses**. "No measurable difference" is *not* an
improvement. A metric that cannot be read is reported as **unmeasured**, never as passed.

Importance values are not a proxy: they are self-reported by the same model that wrote
the line, so they cannot stand in for metric 1.

## Invariants that must hold in both arms

| Invariant | How it is observed |
|---|---|
| Player authority | every reflected line is an ordinary `memories` row (`sourceType: dreamer`, `metadataJson.source: reflect`) that the player can edit or delete on the Memory panel; the task writes no parallel store |
| Prefix discipline | no compartment, chapter or m[0] prefix is written by the task; metric 3 is the observation |
| Domain-legal vocabulary | the accepted categories come from `factCategoriesForDomain(active domain)`; `reflect.test.ts` pins both directions (an ongoing-interaction category accepted, a coding category refused) |
| One writer per project | a module-managed project writes its lines through the Rust module authority, never through the TypeScript store |
| No transcript leakage | a line that echoes a long verbatim run of a player message is rejected by the shared near-transcription check |

## Not judged (restated for this task)

- Whether a reflection is *useful* to a player reading the Memory panel.
- Narrative quality, tone and emotional appropriateness of a reflected line.
- Whether a reflection picked the right level of abstraction.
- Whether the task chose to reflect at all, when zero learnings was the honest answer.

These need a human or model grader. Until one exists and is recorded, a `reflect` change
must be reported as **"metrics unmeasured"**, never as "the reflection is verified good".

## Instrument

1. Fixture: a memory stream with (a) one explicitly stated relationship milestone, (b) one
   merely *observed* item that must never be asserted as a trait, and (c) a later probe
   turn that asks about the milestone.
2. Both arms run the memory live loop with the rubric required:

   ```sh
   node tools/live-run/memory/run-memory-live-loop.mjs \
     --report <out.json> --manifest <fixture.json> --card assets/tavern/presets/deepseek-chan/card.json \
     --require-historian-rubric --require-chapter
   ```

3. A reflect arm additionally needs the dreamer scheduled inside that session (today the
   loop does not schedule dreamer tasks) and a dreamer model provider. The rows it wrote
   are read back from Magic Context's database for metrics 1 and 4; m[0] and the revision
   counts come from the loop report.

## Why this is not run yet (stated, not glossed)

- No harness runs a single dreamer task end to end against a real provider. The memory
  live loop exercises the historian fold and the chapter rollup; the dreamer task path
  needs a host process (the Pi extension or the OpenCode plugin) to create its child
  session, and no loop-side entry point exists for it.
- No dreamer model credential is configured in the measurement environment.

`reflect.test.ts` proves the task writes a domain-legal `memories` row under a real
per-project lease against a real SQLite database. That is plumbing evidence and is
**not** substituted for the paired run this file describes.
