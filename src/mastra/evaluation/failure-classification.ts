import { ZodError } from "zod";
import type { MeasurementRecord } from "../contracts/finance";
import { FinanceCsvError } from "../connectors/finance-csv";
import { DatasetCatalogError } from "../datasets/catalog";
import { redactSensitiveText } from "../security/chat-policy";
import {
  AuthorizationError,
  ConfigurationError,
} from "../security/permission-context";
import { CollectionFixtureError } from "./collection-fixture";

export type HarnessFailureCategory = Exclude<
  MeasurementRecord["failureCategory"],
  undefined
>;

export type ClassifiedHarnessFailure = {
  category: HarnessFailureCategory;
  /** Bounded, redacted text for operator logs; never stored in a record. */
  diagnosticMessage: string;
};

export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 300;

/** Collapse, redact, and bound free text before it reaches a log or sidecar. */
export function boundedDiagnosticMessage(value: string): string {
  const collapsed = redactSensitiveText(value.replace(/\s+/g, " ").trim());
  return collapsed.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH - 1)}…`
    : collapsed;
}

function zodDiagnostic(error: ZodError): string {
  // Paths and issue codes only: Zod messages can echo received values.
  const issues = error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`);
  const more =
    error.issues.length > issues.length
      ? ` (+${error.issues.length - issues.length} more)`
      : "";
  return `Schema validation failed at ${issues.join("; ")}${more}`;
}

function errorText(error: Error): string {
  return `${error.name}: ${error.message}`;
}

function isFileSystemError(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  const syscall = (error as { syscall?: unknown }).syscall;
  return (
    typeof code === "string" &&
    typeof syscall === "string" &&
    ["ENOENT", "EACCES", "EISDIR", "ENOTDIR", "EPERM", "EMFILE"].includes(code)
  );
}

/**
 * True for an error whose type shows it was raised by the harness or the
 * application rather than by the model provider. Used to keep such errors out
 * of the provider failure counts even when they surface from Agent.generate().
 */
export function isNonProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    error instanceof ZodError ||
    error instanceof CollectionFixtureError ||
    error instanceof FinanceCsvError ||
    error instanceof DatasetCatalogError ||
    error instanceof AuthorizationError ||
    error instanceof ConfigurationError ||
    error instanceof ReferenceError ||
    error instanceof RangeError ||
    error instanceof SyntaxError
  ) {
    return true;
  }
  // undici reports a network failure as "TypeError: fetch failed"; any other
  // TypeError is a programming error in the harness.
  return error instanceof TypeError && !/fetch failed/i.test(error.message);
}

/**
 * Map an error that is not a provider failure onto the existing measurement
 * failure categories:
 *
 * - `authorization`: the evaluation permission context was rejected.
 * - `validation`: a record or configuration object failed its Zod schema.
 * - `data`: the task fixture could not be read, parsed, registered, or did
 *   not match its frozen checksum.
 * - `evaluator`: a programming or configuration error in the harness.
 * - `unknown`: a non-Error value was thrown.
 */
export function classifyHarnessFailure(
  error: unknown,
): ClassifiedHarnessFailure {
  if (error instanceof ZodError) {
    return {
      category: "validation",
      diagnosticMessage: boundedDiagnosticMessage(zodDiagnostic(error)),
    };
  }
  if (!(error instanceof Error)) {
    return {
      category: "unknown",
      diagnosticMessage: "A non-Error value was thrown.",
    };
  }

  const diagnosticMessage = boundedDiagnosticMessage(errorText(error));
  if (error instanceof AuthorizationError) {
    return { category: "authorization", diagnosticMessage };
  }
  if (error instanceof DatasetCatalogError) {
    return {
      category: error.status === 403 ? "authorization" : "data",
      diagnosticMessage,
    };
  }
  if (
    error instanceof CollectionFixtureError ||
    error instanceof FinanceCsvError ||
    isFileSystemError(error)
  ) {
    return { category: "data", diagnosticMessage };
  }
  return { category: "evaluator", diagnosticMessage };
}
