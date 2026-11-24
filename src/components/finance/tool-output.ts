import {
  analysisRunResultSchema,
  type AnalysisRunResult,
} from "@/mastra/contracts/finance";

// Tool output reaches the UI either as an object or as a JSON string,
// depending on how the tool result was stored. Normalise both to an object.
export function toolOutputRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return undefined;
    }
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return undefined;
  }
  return candidate as Record<string, unknown>;
}

export function financeAnalysisFromOutput(
  value: unknown,
): AnalysisRunResult | undefined {
  const record = toolOutputRecord(value);
  if (!record) return undefined;
  const parsed = analysisRunResultSchema.safeParse(record);
  return parsed.success ? parsed.data : undefined;
}

// Base64 PNG payloads produced by chart-generating tools.
export function toolOutputImages(value: unknown): string[] {
  const images = toolOutputRecord(value)?.images;
  if (!Array.isArray(images)) return [];
  return images.filter(
    (image): image is string => typeof image === "string" && image.length > 0,
  );
}
