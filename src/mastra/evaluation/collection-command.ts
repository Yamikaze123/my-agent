import type { Agent } from "@mastra/core/agent";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  collectionManifestSchema,
  environmentManifestSchema,
  evaluationTaskSetSchema,
  type CollectionBatch,
  type CollectionManifest,
  type EnvironmentManifest,
  type EvaluationTaskSet,
  type EvaluationVariant,
} from "./contracts";
import {
  createCollectionManifest,
  runCollection,
  sha256Content,
  type CollectionExecutor,
} from "./collection";
import {
  writeImmutableCollectionManifest,
  writeImmutableCollectionBatch,
} from "./measurement-record";
import { createMastraProviderCollectionExecutor } from "./provider-runner";
import type { PermissionContext } from "../security/permission-context";

const COLLECTION_VARIANT_IDS = [
  "baseline",
  "governed",
  "ablation",
] as const satisfies readonly EvaluationVariant["id"][];

export type CollectionAgentMap = Partial<
  Record<EvaluationVariant["id"], Agent>
>;

export type CollectionAgentSet = Record<EvaluationVariant["id"], Agent>;

export type CollectionCommandOptions = {
  /** Absolute or root-relative path to the already-frozen final manifest. */
  manifestPath: string;
  /** Defaults to evaluation/configs/environment-manifest.json. */
  environmentManifestPath?: string;
  /** Defaults to evaluation/tasks/held-out.json. */
  taskSetPath?: string;
  /** Defaults to process.cwd(). */
  rootDir?: string;
  agents: CollectionAgentMap;
  permissionContext?: PermissionContext;
  /** Tests may disable Git verification when running from a temporary root. */
  verifyGitState?: boolean;
};

export type CollectionCommandResult = {
  manifestPath: string;
  resultPath: string;
  manifest: CollectionManifest;
  batch: CollectionBatch;
};

export type CollectionManifestFreezeOptions = {
  /** Absolute or root-relative path for the new final manifest. */
  outputPath: string;
  /** Defaults to evaluation/configs/environment-manifest.json. */
  environmentManifestPath?: string;
  /** Defaults to process.cwd(). */
  rootDir?: string;
  /** Defaults to the candidateVersion already bound in the environment file. */
  candidateVersion?: string;
  /** Defaults to the sourceCommit already bound in the environment file. */
  sourceCommit?: string;
  manifestVersion?: string;
  measurementBatchId: string;
  resultLocation: string;
  inputPriceUsdPerMillionTokens: number;
  outputPriceUsdPerMillionTokens: number;
  taskOrderPolicy?: "manifest-order" | "seeded-shuffle";
  randomizationSeed?: string;
  createdAt?: string;
  /** Tests may disable Git verification when running from a temporary root. */
  verifyGitState?: boolean;
};

export type CollectionManifestFreezeResult = {
  outputPath: string;
  environmentManifestHash: string;
  manifest: CollectionManifest;
};

export class CollectionCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectionCommandError";
  }
}

function readJson(filePath: string, label: string): unknown {
  let serialized: string;
  try {
    serialized = readFileSync(filePath, "utf8");
  } catch {
    throw new CollectionCommandError(
      `Could not read the ${label} at ${filePath}.`,
    );
  }

  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new CollectionCommandError(
      `The ${label} at ${filePath} is not valid JSON.`,
    );
  }
}

function parseManifest(filePath: string): CollectionManifest {
  try {
    return collectionManifestSchema.parse(
      readJson(filePath, "collection manifest"),
    );
  } catch (error) {
    if (error instanceof CollectionCommandError) throw error;
    throw new CollectionCommandError(
      `The collection manifest at ${filePath} does not satisfy the final collection schema.`,
    );
  }
}

function parseEnvironmentManifest(filePath: string): EnvironmentManifest {
  try {
    return environmentManifestSchema.parse(
      readJson(filePath, "environment manifest"),
    );
  } catch (error) {
    if (error instanceof CollectionCommandError) throw error;
    throw new CollectionCommandError(
      `The environment manifest at ${filePath} is invalid.`,
    );
  }
}

function parseTaskSet(filePath: string): EvaluationTaskSet {
  try {
    return evaluationTaskSetSchema.parse(
      readJson(filePath, "held-out task set"),
    );
  } catch (error) {
    if (error instanceof CollectionCommandError) throw error;
    throw new CollectionCommandError(
      `The held-out task set at ${filePath} is invalid.`,
    );
  }
}

function resolveInputPath(rootDir: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(rootDir, filePath);
}

function resolveResultPath(
  rootDir: string,
  manifest: CollectionManifest,
): string {
  const resultsRoot = resolve(rootDir, "evaluation", "results");
  const resultPath = resolve(rootDir, manifest.collection.resultLocation);
  const relativeResultPath = relative(resultsRoot, resultPath);
  if (
    relativeResultPath.length === 0 ||
    isAbsolute(relativeResultPath) ||
    relativeResultPath === ".." ||
    relativeResultPath.startsWith(`..${sep}`)
  ) {
    throw new CollectionCommandError(
      "The collection result location must remain inside evaluation/results.",
    );
  }
  return resultPath;
}

function resolveManifestOutputPath(
  rootDir: string,
  outputPath: string,
): string {
  const configsRoot = resolve(rootDir, "evaluation", "configs");
  const manifestPath = resolveInputPath(rootDir, outputPath);
  const relativeManifestPath = relative(configsRoot, manifestPath);
  if (
    relativeManifestPath.length === 0 ||
    isAbsolute(relativeManifestPath) ||
    relativeManifestPath === ".." ||
    relativeManifestPath.startsWith(`..${sep}`)
  ) {
    throw new CollectionCommandError(
      "The final collection manifest must remain inside evaluation/configs.",
    );
  }
  return manifestPath;
}

function assertEnvironmentBinding(
  manifest: CollectionManifest,
  environment: EnvironmentManifest,
): void {
  if (
    manifest.collection.environmentManifest.manifestVersion !==
    environment.manifestVersion
  ) {
    throw new CollectionCommandError(
      "The collection manifest references a different environment manifest version.",
    );
  }
  if (manifest.candidateVersion !== environment.candidateVersion) {
    throw new CollectionCommandError(
      "The environment manifest candidateVersion does not match the collection manifest.",
    );
  }
  if (manifest.collection.sourceCommit !== environment.sourceCommit) {
    throw new CollectionCommandError(
      "The environment manifest sourceCommit does not match the collection manifest.",
    );
  }
  if (
    sha256Content(JSON.stringify(environment)) !==
    manifest.collection.environmentManifest.contentHash
  ) {
    throw new CollectionCommandError(
      "The environment manifest content hash does not match the collection manifest.",
    );
  }
}

function gitValue(rootDir: string, args: readonly string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new CollectionCommandError(
      "The collection command could not verify the Git state of the source checkout.",
    );
  }
}

function repoRelativePath(rootDir: string, filePath: string): string {
  const absolutePath = resolve(rootDir, filePath);
  const relativePath = relative(rootDir, absolutePath);
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new CollectionCommandError(
      "A Git guard exclusion must remain inside the source checkout.",
    );
  }
  return relativePath.split(sep).join("/");
}

function gitStatusExclusions(
  rootDir: string,
  allowedDirtyPaths: readonly string[],
): string[] {
  // Documentation is deliberately outside the executable candidate boundary.
  // The other paths are freeze-time evidence, not source code. Keep this list
  // explicit so a new dirty source file still blocks collection.
  const paths = ["doc", ...allowedDirtyPaths].map((path) =>
    repoRelativePath(rootDir, path),
  );
  return [...new Set(paths)].flatMap((path) => [
    `:(exclude)${path}`,
    `:(exclude)${path}/**`,
  ]);
}

function assertGitStateForCommit(
  rootDir: string,
  sourceCommit: string,
  allowedDirtyPaths: readonly string[] = [],
): void {
  const currentCommit = gitValue(rootDir, ["rev-parse", "HEAD"]);
  if (currentCommit !== sourceCommit) {
    throw new CollectionCommandError(
      "The current Git commit does not match the collection sourceCommit.",
    );
  }
  const status = gitValue(rootDir, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ".",
    ...gitStatusExclusions(rootDir, allowedDirtyPaths),
  ]);
  if (status.length > 0) {
    throw new CollectionCommandError(
      "The source checkout must be clean before provider collection.",
    );
  }
}

/**
 * Freeze the release manifest from a prepared environment manifest. The
 * environment file is input evidence, never an output that this command
 * silently edits. Existing manifests are immutable and cannot be replaced.
 */
export function freezeCollectionManifest(
  options: CollectionManifestFreezeOptions,
): CollectionManifestFreezeResult {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const environmentManifestPath = resolveInputPath(
    rootDir,
    options.environmentManifestPath ??
      "evaluation/configs/environment-manifest.json",
  );
  const outputPath = resolveManifestOutputPath(rootDir, options.outputPath);
  const environment = parseEnvironmentManifest(environmentManifestPath);
  const candidateVersion =
    options.candidateVersion ?? environment.candidateVersion;
  const sourceCommit = options.sourceCommit ?? environment.sourceCommit;

  if (candidateVersion !== environment.candidateVersion) {
    throw new CollectionCommandError(
      "The requested candidateVersion does not match the environment manifest.",
    );
  }
  if (sourceCommit !== environment.sourceCommit) {
    throw new CollectionCommandError(
      "The requested sourceCommit does not match the environment manifest.",
    );
  }
  if (candidateVersion === "working-tree") {
    throw new CollectionCommandError(
      "A final collection manifest requires a versioned candidate, not working-tree.",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new CollectionCommandError(
      "A final collection manifest requires a 40-character Git sourceCommit.",
    );
  }
  if (options.verifyGitState !== false) {
    assertGitStateForCommit(rootDir, sourceCommit, [
      environmentManifestPath,
      outputPath,
    ]);
  }
  if (existsSync(outputPath)) {
    throw new CollectionCommandError(
      `Collection manifest already exists at ${outputPath}.`,
    );
  }

  const environmentManifestHash = sha256Content(JSON.stringify(environment));
  let manifest: CollectionManifest;
  try {
    manifest = createCollectionManifest({
      manifestVersion: options.manifestVersion,
      measurementBatchId: options.measurementBatchId,
      candidateVersion,
      sourceCommit,
      environmentManifest: environment,
      environmentManifestHash,
      resultLocation: options.resultLocation,
      inputPriceUsdPerMillionTokens: options.inputPriceUsdPerMillionTokens,
      outputPriceUsdPerMillionTokens: options.outputPriceUsdPerMillionTokens,
      taskOrderPolicy: options.taskOrderPolicy,
      randomizationSeed: options.randomizationSeed,
      createdAt: options.createdAt,
    });
  } catch (error) {
    if (error instanceof CollectionCommandError) throw error;
    throw new CollectionCommandError(
      "The final collection manifest inputs do not satisfy the release schema.",
    );
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  try {
    writeImmutableCollectionManifest(outputPath, manifest);
  } catch (error) {
    throw new CollectionCommandError(
      error instanceof Error
        ? error.message
        : `Could not write the final collection manifest at ${outputPath}.`,
    );
  }

  return { outputPath, environmentManifestHash, manifest };
}

export function resolveCollectionAgents(
  agents: CollectionAgentMap,
): CollectionAgentSet {
  const missing = COLLECTION_VARIANT_IDS.filter(
    (variantId) => !agents[variantId],
  );
  if (missing.length > 0) {
    throw new CollectionCommandError(
      `Provider collection requires one agent for every variant; missing: ${missing.join(", ")}.`,
    );
  }

  return {
    baseline: agents.baseline as Agent,
    governed: agents.governed as Agent,
    ablation: agents.ablation as Agent,
  };
}

export async function runCollectionCommand(
  options: CollectionCommandOptions,
): Promise<CollectionCommandResult> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const manifestPath = resolveInputPath(rootDir, options.manifestPath);
  const environmentManifestPath = resolveInputPath(
    rootDir,
    options.environmentManifestPath ??
      "evaluation/configs/environment-manifest.json",
  );
  const taskSetPath = resolveInputPath(
    rootDir,
    options.taskSetPath ?? "evaluation/tasks/held-out.json",
  );
  const manifest = parseManifest(manifestPath);
  const environment = parseEnvironmentManifest(environmentManifestPath);
  const taskSet = parseTaskSet(taskSetPath);
  const agents = resolveCollectionAgents(options.agents);
  const resultPath = resolveResultPath(rootDir, manifest);

  assertEnvironmentBinding(manifest, environment);
  if (options.verifyGitState !== false) {
    assertGitStateForCommit(rootDir, manifest.collection.sourceCommit, [
      environmentManifestPath,
      manifestPath,
      resultPath,
    ]);
  }
  if (taskSet.purpose !== "held-out") {
    throw new CollectionCommandError(
      "The collection task set must be held-out.",
    );
  }
  if (taskSet.taskSetId !== manifest.taskSets.heldOut) {
    throw new CollectionCommandError(
      `The collection task set must be ${manifest.taskSets.heldOut}.`,
    );
  }
  if (existsSync(resultPath)) {
    throw new CollectionCommandError(
      `Collection batch already exists at ${resultPath}.`,
    );
  }

  const executor: CollectionExecutor = createMastraProviderCollectionExecutor({
    agents,
    permissionContext: options.permissionContext,
    rootDir,
  });
  const batch = await runCollection({
    manifest,
    taskSet,
    executor,
  });

  mkdirSync(dirname(resultPath), { recursive: true });
  writeImmutableCollectionBatch(resultPath, batch);
  return { manifestPath, resultPath, manifest, batch };
}
