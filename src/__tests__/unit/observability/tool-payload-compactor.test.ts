import { describe, expect, it } from "vitest";
import type { AnySpan } from "@mastra/core/observability";
import {
  compactTracePayload,
  MAX_TRACE_STRING_LENGTH,
  ToolPayloadCompactor,
} from "@/mastra/observability/tool-payload-compactor";

function span(fields: Partial<AnySpan>): AnySpan {
  return {
    id: "span-1",
    traceId: "trace-1",
    name: "tool",
    ...fields,
  } as AnySpan;
}

describe("ToolPayloadCompactor", () => {
  it("replaces image payloads with a count and bounds logs in tool spans", () => {
    const image = "A".repeat(500_000);
    const processed = new ToolPayloadCompactor().process(
      span({
        input: { code: "print(1)" },
        output: {
          stdout: "x".repeat(20_000),
          stderr: "",
          images: [image, image],
          success: true,
        },
      }),
    );

    expect(processed?.input).toEqual({ code: "print(1)" });
    expect(processed?.output.images).toEqual([]);
    expect(processed?.output.imageCount).toBe(2);
    expect(processed?.output.stdout.length).toBeLessThan(8_100);
    expect(processed?.output.stdout).toContain("[truncated");
    expect(JSON.stringify(processed?.output)).not.toContain("AAAAAAAA");
  });

  it("caps long strings under any key, including nested message content", () => {
    const compacted = compactTracePayload({
      messages: [
        {
          role: "tool",
          content: [{ type: "image", data: "B".repeat(100_000) }],
        },
      ],
      note: "short",
    }) as {
      messages: Array<{ content: Array<{ data: string }> }>;
      note: string;
    };

    expect(compacted.note).toBe("short");
    expect(compacted.messages[0].content[0].data.length).toBe(
      MAX_TRACE_STRING_LENGTH + "\n[truncated before trace export]".length,
    );
  });

  it("leaves small payloads unchanged and tolerates missing spans", () => {
    const processor = new ToolPayloadCompactor();
    const small = span({
      output: { value: 14, dimensions: { ticker: "AAPL" } },
    });

    expect(processor.process(small)?.output).toEqual({
      value: 14,
      dimensions: { ticker: "AAPL" },
    });
    expect(processor.process(undefined)).toBeUndefined();
    expect(processor.process(span({}))).toMatchObject({ id: "span-1" });
  });
});
