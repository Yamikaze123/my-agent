import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  FinanceCsvError,
  MAX_CSV_COLUMNS,
  MAX_CSV_FILE_BYTES,
  MAX_CSV_FIELD_LENGTH,
  MAX_CSV_ROWS,
  parseFinanceCsv,
} from "@/mastra/connectors/finance-csv";

function csvBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function expectCsvError(action: () => unknown, code: string): FinanceCsvError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(FinanceCsvError);
  expect(caught).toMatchObject({ code });
  return caught as FinanceCsvError;
}

describe("finance CSV parser", () => {
  it("accepts UTF-8 BOM, CRLF, quoted commas, escaped quotes, and embedded newlines", () => {
    const result = parseFinanceCsv(
      csvBytes(
        '\uFEFFTicker,Date,Adj Close,Notes\r\nAAPL,2025-01-31,102,"split, adjusted"\r\nMSFT,2025-02-28,200,"said ""hello""\nand goodbye"\r\n',
      ),
    );

    expect(result.columns).toEqual(["Ticker", "Date", "Adj_Close", "Notes"]);
    expect(result.rows).toEqual([
      ["AAPL", "2025-01-31", 102, "split, adjusted"],
      ["MSFT", "2025-02-28", 200, 'said "hello"\nand goodbye'],
    ]);
    expect(result.schema).toMatchObject([
      { name: "Ticker", logicalType: "string", semanticRole: "ticker" },
      { name: "Date", logicalType: "date", semanticRole: "date" },
      { name: "Adj_Close", logicalType: "integer", semanticRole: "price" },
      { name: "Notes", logicalType: "string", semanticRole: "dimension" },
    ]);
  });

  it("infers numeric, boolean, and nullable fields while skipping blank lines", () => {
    const result = parseFinanceCsv(
      csvBytes(
        "date,return,active,note\n2025-01-31,0.05,true,\n\n2025-02-28,-0.02,false,review\n",
      ),
    );

    expect(result.rows).toEqual([
      ["2025-01-31", 0.05, true, null],
      ["2025-02-28", -0.02, false, "review"],
    ]);
    expect(result.schema).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "return",
          logicalType: "number",
          semanticRole: "return",
        }),
        expect.objectContaining({
          name: "active",
          logicalType: "boolean",
          semanticRole: "dimension",
        }),
        expect.objectContaining({ name: "note", nullable: true }),
      ]),
    );
  });

  it.each([
    ["empty input", new Uint8Array(), "empty_file"],
    ["invalid UTF-8", new Uint8Array([0xff, 0xfe]), "invalid_encoding"],
    [
      "unclosed quote",
      csvBytes('date,note\n2025-01-31,"open'),
      "malformed_csv",
    ],
    ["bare CR", csvBytes("date\r2025-01-31"), "malformed_csv"],
    [
      "text after closing quote",
      csvBytes('date,note\n2025-01-31,"ok"x'),
      "malformed_csv",
    ],
    [
      "duplicate headers",
      csvBytes("Date,date\n2025-01-31,2025-01-31"),
      "duplicate_header",
    ],
    [
      "invalid header",
      csvBytes("date,Adj (Close)\n2025-01-31,100"),
      "invalid_header",
    ],
    [
      "inconsistent row width",
      csvBytes("date,close\n2025-01-31,100\n2025-02-28"),
      "row_width_mismatch",
    ],
    ["header only", csvBytes("date,close\n"), "empty_file"],
  ] as const)("rejects %s with a typed error", (_caseName, bytes, code) => {
    expectCsvError(() => parseFinanceCsv(bytes), code);
  });

  it("enforces byte, row, column, and cell limits", () => {
    expectCsvError(
      () => parseFinanceCsv(new Uint8Array(MAX_CSV_FILE_BYTES + 1)),
      "field_too_large",
    );

    const tooManyRows = `date\n${"2025-01-31\n".repeat(MAX_CSV_ROWS + 1)}`;
    expectCsvError(
      () => parseFinanceCsv(csvBytes(tooManyRows)),
      "too_many_rows",
    );

    const tooManyColumns = Array.from(
      { length: MAX_CSV_COLUMNS + 1 },
      (_, index) => `field_${index}`,
    ).join(",");
    expectCsvError(
      () =>
        parseFinanceCsv(
          csvBytes(`${tooManyColumns}\n${"x,".repeat(MAX_CSV_COLUMNS)}x`),
        ),
      "too_many_columns",
    );

    const oversizedCell = `note\n${"x".repeat(MAX_CSV_FIELD_LENGTH + 1)}`;
    expectCsvError(
      () => parseFinanceCsv(csvBytes(oversizedCell)),
      "field_too_large",
    );
  });

  it("rejects parsing that exceeds the configured time limit", () => {
    const now = vi.spyOn(performance, "now");
    now
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1_001);

    try {
      expectCsvError(
        () => parseFinanceCsv(csvBytes("date\n2025-01-31")),
        "parse_timeout",
      );
    } finally {
      now.mockRestore();
    }
  });

  it("reports HTTP-oriented status codes for input failures", () => {
    expect(
      expectCsvError(
        () => parseFinanceCsv(new Uint8Array([0xff])),
        "invalid_encoding",
      ).status,
    ).toBe(415);
    expect(
      expectCsvError(
        () => parseFinanceCsv(new Uint8Array(MAX_CSV_FILE_BYTES + 1)),
        "field_too_large",
      ).status,
    ).toBe(413);
  });
});
