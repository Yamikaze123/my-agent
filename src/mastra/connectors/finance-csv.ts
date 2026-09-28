import { performance } from "node:perf_hooks";
import {
  financeDateSchema,
  isoTimestampSchema,
  schemaFieldSchema,
  type SchemaField,
} from "../contracts/finance";

export const MAX_CSV_FILE_BYTES = 1_048_576;
export const MAX_CSV_ROWS = 10_000;
export const MAX_CSV_COLUMNS = 32;
export const MAX_CSV_PARSE_TIME_MS = 1_000;
export const MAX_CSV_FIELD_LENGTH = 32_768;

export type CsvScalar = string | number | boolean | null;

export type ParsedFinanceCsv = {
  columns: string[];
  rows: CsvScalar[][];
  schema: SchemaField[];
};

export class FinanceCsvError extends Error {
  constructor(
    public readonly code:
      | "empty_file"
      | "invalid_encoding"
      | "malformed_csv"
      | "invalid_header"
      | "duplicate_header"
      | "row_width_mismatch"
      | "too_many_rows"
      | "too_many_columns"
      | "field_too_large"
      | "parse_timeout",
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "FinanceCsvError";
  }
}

function checkParseTime(startedAt: number): void {
  if (performance.now() - startedAt > MAX_CSV_PARSE_TIME_MS) {
    throw new FinanceCsvError(
      "parse_timeout",
      "CSV parsing exceeded the one-second limit.",
      408,
    );
  }
}

function parseRecords(text: string): string[][] {
  const startedAt = performance.now();
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let recordStarted = false;

  const appendCharacter = (character: string) => {
    field += character;
    if (field.length > MAX_CSV_FIELD_LENGTH) {
      throw new FinanceCsvError(
        "field_too_large",
        "A CSV cell exceeds the 32,768-character limit.",
        413,
      );
    }
  };

  const finishField = () => {
    if (row.length >= MAX_CSV_COLUMNS) {
      throw new FinanceCsvError(
        "too_many_columns",
        `CSV files may contain at most ${MAX_CSV_COLUMNS} columns.`,
        413,
      );
    }
    row.push(field);
    field = "";
    afterQuote = false;
  };

  const finishRecord = () => {
    if (recordStarted) {
      finishField();
      if (records.length >= MAX_CSV_ROWS + 1) {
        throw new FinanceCsvError(
          "too_many_rows",
          `CSV files may contain at most ${MAX_CSV_ROWS} data rows.`,
          413,
        );
      }
      records.push(row);
    }
    row = [];
    field = "";
    inQuotes = false;
    afterQuote = false;
    recordStarted = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    if ((index & 4095) === 0) checkParseTime(startedAt);

    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          appendCharacter('"');
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        appendCharacter(character);
      }
      continue;
    }

    if (afterQuote) {
      if (character === ",") {
        finishField();
        recordStarted = true;
        continue;
      }
      if (character === "\n") {
        finishRecord();
        continue;
      }
      if (character === "\r" && text[index + 1] === "\n") {
        finishRecord();
        index += 1;
        continue;
      }
      throw new FinanceCsvError(
        "malformed_csv",
        "CSV contains characters after a closing quote.",
      );
    }

    if (character === '"') {
      if (field.length > 0) {
        throw new FinanceCsvError(
          "malformed_csv",
          "CSV quotes must begin at the start of a cell.",
        );
      }
      inQuotes = true;
      recordStarted = true;
      continue;
    }

    if (character === ",") {
      finishField();
      recordStarted = true;
      continue;
    }

    if (character === "\n") {
      finishRecord();
      continue;
    }

    if (character === "\r") {
      if (text[index + 1] !== "\n") {
        throw new FinanceCsvError(
          "malformed_csv",
          "CSV line endings must be LF or CRLF.",
        );
      }
      finishRecord();
      index += 1;
      continue;
    }

    appendCharacter(character);
    recordStarted = true;
  }

  checkParseTime(startedAt);
  if (inQuotes) {
    throw new FinanceCsvError(
      "malformed_csv",
      "CSV contains an unclosed quoted cell.",
    );
  }
  if (recordStarted || row.length > 0 || field.length > 0 || afterQuote) {
    finishRecord();
  }

  return records;
}

function isDate(value: string): boolean {
  return financeDateSchema.safeParse(value).success;
}

function isDateTime(value: string): boolean {
  return isoTimestampSchema.safeParse(value).success;
}

function numericValue(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferLogicalType(
  values: readonly string[],
): SchemaField["logicalType"] {
  const populated = values.filter((value) => value !== "");
  if (populated.length === 0) return "string";

  if (populated.every((value) => /^(true|false)$/i.test(value.trim()))) {
    return "boolean";
  }
  if (populated.every(isDate)) return "date";
  if (populated.every(isDateTime)) return "datetime";

  const numbers = populated.map(numericValue);
  if (numbers.every((value) => value !== undefined)) {
    return numbers.every(
      (value) => value !== undefined && Number.isInteger(value),
    )
      ? "integer"
      : "number";
  }

  return "string";
}

function inferSemanticRole(
  name: string,
  logicalType: SchemaField["logicalType"],
): SchemaField["semanticRole"] {
  const normalized = name.toLowerCase().replace(/[.-]/g, "_");
  if (/(^|_)(ticker|symbol)(_|$)/.test(normalized)) return "ticker";
  if (/(^|_)(date|datetime|timestamp)(_|$)/.test(normalized)) return "date";
  if (
    /(^|_)(adjusted_close|adj_close|close|open|high|low|price)(_|$)/.test(
      normalized,
    )
  ) {
    return "price";
  }
  if (/(^|_)(return|returns)(_|$)/.test(normalized)) return "return";
  if (/(^|_)(currency|ccy)(_|$)/.test(normalized)) return "currency";
  if (/(^|_)(id|identifier)(_|$)/.test(normalized)) return "identifier";
  if (logicalType === "integer" || logicalType === "number") return "measure";
  if (logicalType === "string" || logicalType === "boolean") return "dimension";
  return "unknown";
}

function valueForType(
  value: string,
  logicalType: SchemaField["logicalType"],
): CsvScalar {
  if (value === "") return null;
  switch (logicalType) {
    case "integer":
    case "number":
      return numericValue(value) ?? value;
    case "boolean":
      return value.trim().toLowerCase() === "true";
    default:
      return value;
  }
}

export function parseFinanceCsv(bytes: Uint8Array): ParsedFinanceCsv {
  const startedAt = performance.now();
  if (bytes.byteLength === 0) {
    throw new FinanceCsvError("empty_file", "The CSV file is empty.");
  }
  if (bytes.byteLength > MAX_CSV_FILE_BYTES) {
    throw new FinanceCsvError(
      "field_too_large",
      `CSV files may not exceed ${MAX_CSV_FILE_BYTES} bytes.`,
      413,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FinanceCsvError(
      "invalid_encoding",
      "CSV files must use valid UTF-8 encoding.",
      415,
    );
  }
  if (text.startsWith("\uFEFF")) text = text.slice(1);

  const records = parseRecords(text);
  if (records.length === 0) {
    throw new FinanceCsvError("empty_file", "The CSV file has no header row.");
  }

  const headers = records[0].map((header) =>
    header.trim().replace(/\s+/g, "_"),
  );
  if (headers.length === 0 || headers.length > MAX_CSV_COLUMNS) {
    throw new FinanceCsvError(
      "too_many_columns",
      `CSV files must contain between 1 and ${MAX_CSV_COLUMNS} columns.`,
      413,
    );
  }

  const seenHeaders = new Set<string>();
  for (const header of headers) {
    if (!schemaFieldSchema.shape.name.safeParse(header).success) {
      throw new FinanceCsvError(
        "invalid_header",
        "CSV headers must start with a letter or underscore and contain only letters, numbers, underscores, periods, or hyphens.",
      );
    }
    const key = header.toLowerCase();
    if (seenHeaders.has(key)) {
      throw new FinanceCsvError(
        "duplicate_header",
        "CSV headers must be unique, ignoring case.",
      );
    }
    seenHeaders.add(key);
  }

  const rawRows = records.slice(1);
  if (rawRows.length === 0) {
    throw new FinanceCsvError(
      "empty_file",
      "CSV files must contain at least one data row.",
    );
  }
  rawRows.forEach((row) => {
    if (row.length !== headers.length) {
      throw new FinanceCsvError(
        "row_width_mismatch",
        "Every CSV row must have the same number of cells as the header.",
      );
    }
  });

  const schema = headers.map((name, columnIndex) => {
    const values = rawRows.map((row) => row[columnIndex]);
    const logicalType = inferLogicalType(values);
    return schemaFieldSchema.parse({
      name,
      logicalType,
      nullable: values.some((value) => value === ""),
      semanticRole: inferSemanticRole(name, logicalType),
    });
  });

  const parsed = {
    columns: headers,
    rows: rawRows.map((row) =>
      row.map((value, columnIndex) =>
        valueForType(value, schema[columnIndex].logicalType),
      ),
    ),
    schema,
  };
  checkParseTime(startedAt);
  return parsed;
}
