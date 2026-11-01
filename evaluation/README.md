# Evaluation harness

This directory contains the versioned measurement handoff for the finance
capstone. The harness is deliberately offline-first: the smoke command runs
the deterministic governed workflow and the quality-gate ablation against the
same checked-in fixture, and verifies the shared read-only fixture adapter used
by the historical baseline. It does not call OpenRouter, E2B, or PostgreSQL.

Run the readiness check with:

```bash
pnpm eval:smoke
```

The smoke run must produce three schema-valid `MeasurementRecord` values for
`baseline`, `governed`, and `ablation`. The baseline record is explicitly an
adapter smoke record; it does not claim that the historical tagged agent has
been re-executed. A provider-backed baseline collection run remains a separate
provider-backed collection activity.

The held-out task set contains 30 tasks, including metric, profile, quality,
ambiguous, and unsafe requests. Ten tasks use the defective CSV set, satisfying
the one-third quality-gate-ablation exposure requirement. Development tasks are
kept in a separate file and must not be used to tune final prompts or scoring.

`measurement-manifest.pilot-v1.json` leaves provider prices unset. The companion
`environment-manifest.json` records the runtime/dependency contract and leaves
the source commit as a freeze-time field. Measurement records
therefore use `costStatus: "unpriced"` and do not include a dollar estimate.
Enter verified rates in a new frozen manifest before provider-backed collection;
never overwrite an existing raw result batch.

The TypeScript runner and scorer live in
`src/mastra/evaluation/`. They validate all JSON configuration through Zod,
verify fixture checksums, keep raw rows out of measurement records, classify
workflow failures, and write batches through an exclusive-create helper when a
collection command is added.

## Pilot manifest

`configs/measurement-manifest.pilot-v1.json` freezes the current
pilot design: the task sets, fixture versions and checksums, baseline/governed/
ablation variants, repeat ceiling, run budget, and privacy policy. It is
intentionally not the final release manifest: `candidateVersion` remains
`working-tree`, the companion `environment-manifest.json` still has
`sourceCommit: "record-at-freeze"`, and provider prices remain `null`.

Use this file for pilot planning only. Before the main collection, create a new
immutable manifest after the candidate source is tagged and verified provider
rates are recorded. Do not report estimated dollar costs from this pilot
manifest.

## Collection boundary

The release handoff is implemented in `src/mastra/evaluation/collection.ts`:

- `createCollectionManifest` copies the pilot task, fixture, variant,
  scoring, and privacy definitions while requiring an exact source commit,
  hashed environment manifest, result location, and non-null provider rates.
- `buildCollectionPlan` expands the held-out set into a repeat-aware
  matrix, applies the declared order policy, and checks the run/model-step
  ceilings before execution.
- `runCollection` invokes a supplied variant executor in recorded order,
  retains classified failures, and validates complete task/variant/repetition
  coverage. `measurement-record.ts` writes manifests and batches with
  exclusive-create semantics.
- `provider-runner.ts` adapts an installed Mastra `Agent.generate()` call to a
  redacted measurement record. Supply a separate agent for each architecture;
  the runner does not silently use the governed agent as the historical
  baseline.
- `collection-command.ts` is the orchestration entry point. The
  `freezeCollectionManifest` boundary creates a final manifest exactly once
  from a prepared environment manifest, verified source commit, and explicit
  provider rates. `runCollectionCommand` then validates that manifest’s
  environment binding and clean source commit, requires all three variant
  agents, executes the held-out plan, and writes the result batch exactly once
  under `evaluation/results/`.

The final manifest and provider-backed batch are intentionally not checked in
until the candidate is tagged, the environment manifest is updated with that
same commit, and provider rates are verified. The pilot manifest remains
unchanged.
