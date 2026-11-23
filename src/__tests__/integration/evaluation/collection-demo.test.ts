import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { measurementRecordSchema } from "@/mastra/contracts/finance";
import {
  createCollectionManifest,
  runCollection,
  sha256Content,
  type CollectionProgress,
} from "@/mastra/evaluation/collection";
import { collectionManifestSchema } from "@/mastra/evaluation/contracts";
import {
  environmentManifest,
  heldOutTaskSet,
} from "@/mastra/evaluation/runner";

const DEMO_CANDIDATE = "offline-demo";
const DEMO_SOURCE_COMMIT = "0".repeat(40);
const DEMO_MODEL = {
  provider: "offline-demo",
  model: "synthetic-collection-executor",
};
const verboseDemo = process.env.COLLECTION_DEMO_VERBOSE === "1";

function demoLog(message: string): void {
  if (verboseDemo) process.stdout.write(`${message}\n`);
}

function createDemoManifest() {
  const demoEnvironment = {
    ...environmentManifest,
    candidateVersion: DEMO_CANDIDATE,
    sourceCommit: DEMO_SOURCE_COMMIT,
  };
  const baseManifest = createCollectionManifest({
    measurementBatchId: "offline-collection-demo",
    candidateVersion: DEMO_CANDIDATE,
    sourceCommit: DEMO_SOURCE_COMMIT,
    environmentManifest: demoEnvironment,
    environmentManifestHash: sha256Content(JSON.stringify(demoEnvironment)),
    resultLocation: "evaluation/results/offline-demo-not-written.json",
    inputPriceUsdPerMillionTokens: 0,
    outputPriceUsdPerMillionTokens: 0,
  });

  return collectionManifestSchema.parse({
    ...baseManifest,
    model: { ...baseManifest.model, ...DEMO_MODEL },
    variants: baseManifest.variants.map((variant) => ({
      ...variant,
      model: DEMO_MODEL,
    })),
  });
}

describe("offline collection demo", () => {
  it("demonstrates the complete collection plan without provider calls", async () => {
    const manifest = createDemoManifest();
    const plannedRuns = heldOutTaskSet.tasks.reduce(
      (total, task) =>
        total +
        manifest.variants.length *
          (task.fixture
            ? manifest.repeatPolicy.deterministicTasks
            : manifest.repeatPolicy.stochasticCeiling),
      0,
    );
    demoLog(
      "======================================================================",
    );
    demoLog("COLLECTION DEMO — OFFLINE SIMULATION (not evaluation evidence)");
    demoLog(
      "No provider, model, workflow, tool, or database calls. No result file will be written.",
    );
    demoLog(
      "======================================================================",
    );
    demoLog(
      `[preflight] batch=${manifest.measurementBatchId} candidate=${manifest.candidateVersion} model=${manifest.model.provider}/${manifest.model.model}`,
    );
    demoLog(
      `[preflight] taskSet=${heldOutTaskSet.taskSetId} purpose=${heldOutTaskSet.purpose} tasks=${heldOutTaskSet.tasks.length} variants=${manifest.variants.length} plannedRuns=${plannedRuns}`,
    );
    demoLog(
      `[preflight] retryPolicy=${JSON.stringify(manifest.collection.providerRetryPolicy)} result=${manifest.collection.resultLocation} (not written)`,
    );
    for (const variant of manifest.variants) {
      demoLog(
        `[plan:variant] id=${variant.id} label=${JSON.stringify(variant.label)} execution=${variant.execution} qualityGate=${variant.qualityGate} authorization=${variant.authorization} prompt=${variant.promptVersion} policy=${variant.policyVersion}`,
      );
    }
    demoLog("[collection] Plan validated; starting sequential simulated runs.");

    const batch = await runCollection({
      manifest,
      taskSet: heldOutTaskSet,
      ...(verboseDemo
        ? {
            progressIntervalMs: 1_000,
            onProgress: (progress: CollectionProgress) => {
              const currentRun = progress.currentEntry
                ? ` next=${progress.currentEntry.sequence}/${progress.plannedRuns}:${progress.currentEntry.taskId}/${progress.currentEntry.variant}/rep${progress.currentEntry.repetition}`
                : " next=none";
              demoLog(
                `[collection:progress] completed=${progress.completedRuns}/${progress.plannedRuns} failed=${progress.failedRuns} remaining=${progress.plannedRuns - progress.completedRuns} elapsed=${(progress.elapsedMs / 1_000).toFixed(1)}s${currentRun}`,
              );
            },
          }
        : {}),
      executor: async ({ manifest: requestManifest, entry, task, variant }) => {
        const sequence = `${String(entry.sequence).padStart(3, "0")}/${plannedRuns}`;
        const fixture = task.fixture
          ? task.fixture.kind === "csv"
            ? `csv:${task.fixture.file}`
            : `fixture:${task.fixture.version}`
          : "none";
        const workflowInput = task.workflowInput
          ? JSON.stringify(task.workflowInput)
          : "none";
        demoLog(
          `[run ${sequence}] START task=${task.taskId} kind=${task.kind} variant=${variant.id} repetition=${entry.repetition}`,
        );
        demoLog(
          `[run ${sequence}] INPUT expected=${task.expected.outcome} promptContent=omitted promptChars=${task.prompt.length} workflowInput=${workflowInput} fixture=${fixture}`,
        );
        demoLog(
          `[run ${sequence}] ROUTE execution=${variant.execution} qualityGate=${variant.qualityGate} authorization=${variant.authorization} prompt=${variant.promptVersion} policy=${variant.policyVersion}`,
        );
        demoLog(
          `[run ${sequence}] EXECUTOR mode=synthetic-offline provider=skipped model=skipped workflow=skipped tools=skipped`,
        );

        const startedAt = Date.now();
        await new Promise((resolve) =>
          setTimeout(resolve, verboseDemo ? 50 : 0),
        );
        const latencyMs = Date.now() - startedAt;
        demoLog(
          `[run ${sequence}] RESULT status=completed simulatedLatencyMs=${latencyMs} providerCalls=0 modelCalls=0 toolCalls=0 workflowSteps=0 retries=0`,
        );

        const record = measurementRecordSchema.parse({
          measurementId: randomUUID(),
          batchId: requestManifest.measurementBatchId,
          candidateVersion: requestManifest.candidateVersion,
          taskId: task.taskId,
          variant: variant.id,
          repetition: entry.repetition,
          executionOrder: entry.sequence,
          model: variant.model,
          promptVersion: variant.promptVersion,
          policyVersion: variant.policyVersion,
          status: "completed",
          scores: { "demo-only": 1 },
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            modelCalls: 0,
            costStatus: "unpriced",
            estimatedCostFormula:
              "Offline demo: no provider usage or cost is represented.",
          },
          timing: { latencyMs },
          counts: { toolCalls: 0, workflowSteps: 0, retries: 0 },
          guardrail: {
            decision: "not-evaluated",
            blockedToolCalls: 0,
            redactedValues: 0,
            responseAction: "not-evaluated",
            recovery: "not-evaluated",
          },
          sandboxOutcome: "not-run",
          providerOutcome: "not-called",
          artifactIds: [],
          traceIds: [],
          recordedAt: new Date().toISOString(),
        });
        demoLog(
          `[run ${sequence}] RECORD schema=valid measurementId=${record.measurementId} scores=${JSON.stringify(record.scores)} cost=${record.usage.costStatus} persisted=no`,
        );
        return record;
      },
    });

    const modelCalls = batch.records.reduce(
      (total, record) => total + record.usage.modelCalls,
      0,
    );
    const failedRuns = batch.records.filter(
      (record) => record.status === "failed",
    ).length;
    demoLog("[collection:summary] By variant:");
    for (const variant of manifest.variants) {
      const records = batch.records.filter(
        (record) => record.variant === variant.id,
      );
      const averageLatencyMs = records.length
        ? records.reduce(
            (total, record) => total + record.timing.latencyMs,
            0,
          ) / records.length
        : 0;
      demoLog(
        `[collection:summary] variant=${variant.id} runs=${records.length} completed=${records.filter((record) => record.status === "completed").length} failed=${records.filter((record) => record.status === "failed").length} avgSimulatedLatencyMs=${averageLatencyMs.toFixed(1)}`,
      );
    }
    demoLog(
      `[collection:summary] status=${failedRuns === 0 ? "completed" : "partial"} runs=${batch.collectedRuns}/${batch.plannedRuns} failed=${failedRuns} modelCalls=${modelCalls} providerCalls=0 cost=none resultFile=not-written`,
    );

    expect(batch.plannedRuns).toBe(138);
    expect(batch.collectedRuns).toBe(138);
    expect(
      batch.records.every((record) => record.providerOutcome === "not-called"),
    ).toBe(true);
    expect(modelCalls).toBe(0);
  }, 30_000);
});
