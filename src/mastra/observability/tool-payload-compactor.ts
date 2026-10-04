import type { AnySpan, SpanOutputProcessor } from "@mastra/core/observability";
import { compactLargeToolPayload } from "../security/chat-policy";

export const MAX_TRACE_STRING_LENGTH = 16_000;

function capStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_TRACE_STRING_LENGTH) return value;
    return `${value.slice(0, MAX_TRACE_STRING_LENGTH)}\n[truncated before trace export]`;
  }
  if (value instanceof Date || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) return value.map(capStrings);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      capStrings(child),
    ]),
  );
}

/**
 * Compact span payloads before export. Tool outputs can carry base64 images
 * (up to several megabytes each) and long logs; neither belongs in persisted
 * traces. Images become a count, stdout/stderr are bounded by the shared
 * model-history rule, and any remaining string is capped so an unexpected
 * field cannot carry a large payload either.
 */
export function compactTracePayload(value: unknown): unknown {
  return capStrings(compactLargeToolPayload(value));
}

export class ToolPayloadCompactor implements SpanOutputProcessor {
  readonly name = "tool-payload-compactor";

  process(span?: AnySpan): AnySpan | undefined {
    if (!span) return span;
    if (span.input !== undefined) span.input = compactTracePayload(span.input);
    if (span.output !== undefined) {
      span.output = compactTracePayload(span.output);
    }
    return span;
  }

  async shutdown(): Promise<void> {}
}
