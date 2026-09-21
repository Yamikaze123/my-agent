import type { MastraDBMessage } from "@mastra/core/agent/message-list";

export const CHAT_POLICY_VERSION = "2026-09-20";

export const CHAT_LIMITS = {
  maxMessages: 24,
  maxMessageParts: 32,
  maxTextLength: 12_000,
  maxTotalTextLength: 48_000,
  maxBodyLength: 500_000,
} as const;

export type ChatGuardrailCode =
  | "invalid_request"
  | "message_too_large"
  | "attachment_not_supported"
  | "prompt_injection"
  | "sensitive_data_request"
  | "cross_resource_request"
  | "write_action_not_supported"
  | "investment_advice"
  | "unsupported_domain";

export type GuardrailViolation = {
  code: Exclude<
    ChatGuardrailCode,
    "invalid_request" | "message_too_large" | "attachment_not_supported"
  >;
  userMessage: string;
};

export class ChatGuardrailError extends Error {
  readonly code: ChatGuardrailCode;
  readonly status: 400 | 422;
  readonly userMessage: string;

  constructor(
    code: ChatGuardrailCode,
    userMessage: string,
    status: 400 | 422 = 422,
  ) {
    super(userMessage);
    this.name = "ChatGuardrailError";
    this.code = code;
    this.status = status;
    this.userMessage = userMessage;
  }
}

export const CHAT_POLICY_MATRIX = Object.freeze([
  {
    policyId: "finance-analysis-scope",
    decision: "allow",
    description:
      "Read-only finance analysis, education, visualization, and reproducible computation.",
  },
  {
    policyId: "unsupported-domain",
    decision: "block",
    description:
      "Requests centered on medical, student, retail, manufacturing, legal, or other unsupported records.",
  },
  {
    policyId: "investment-advice",
    decision: "block",
    description:
      "Individualized buy, sell, portfolio, or guaranteed-return recommendations.",
  },
  {
    policyId: "prompt-injection-and-secrets",
    decision: "block",
    description:
      "Requests to override policy or disclose system prompts, credentials, or protected values.",
  },
  {
    policyId: "read-only-actions",
    decision: "block",
    description:
      "Writes, transfers, deletion, publication, or other side-effecting actions without an approval workflow.",
  },
] as const);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeForMatching(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textFromUnknown(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";

  if (Array.isArray(value)) {
    return value.map((item) => textFromUnknown(item, depth + 1)).join(" ");
  }

  const record = value as JsonRecord;
  const textFields = [
    "text",
    "content",
    "parts",
    "stdout",
    "stderr",
    "value",
    "output",
    "result",
    "reasoning",
    "toolInvocations",
  ];
  return textFields
    .filter((key) => key in record)
    .map((key) => textFromUnknown(record[key], depth + 1))
    .filter(Boolean)
    .join(" ");
}

export function extractMessageText(message: unknown): string {
  return textFromUnknown(message).slice(0, CHAT_LIMITS.maxBodyLength);
}

function redactApiKeyAndToken(value: string): string {
  return value
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
      "Bearer [REDACTED_TOKEN]",
    )
    .replace(
      /\b(?:api[_ -]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi,
      (match) => {
        const label = match.split(/[:=]/, 1)[0].trim();
        return `${label}: [REDACTED_SECRET]`;
      },
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    );
}

export function redactSensitiveText(value: string): string {
  return redactApiKeyAndToken(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(
      /(?<![A-Za-z0-9])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
      "[REDACTED_PHONE]",
    )
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED_CARD]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]");
}

const PRESERVED_PROTOCOL_STRING_KEYS = new Set([
  "id",
  "threadId",
  "resourceId",
  "messageId",
  "toolCallId",
  "sourceId",
  "stepId",
]);

function redactStructuredValue(
  value: unknown,
  seen = new WeakSet<object>(),
  key?: string,
): unknown {
  if (typeof value === "string") {
    return key && PRESERVED_PROTOCOL_STRING_KEYS.has(key)
      ? value
      : redactSensitiveText(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return "[REDACTED_CIRCULAR_VALUE]";
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactStructuredValue(item, seen));
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        redactStructuredValue(child, seen, key),
      ]),
    );
  } finally {
    // Track only the current recursion path. Shared references are valid data;
    // only an object encountered again before its parent finishes is cyclic.
    seen.delete(value);
  }
}

export function redactChatMessages(messages: unknown[]): unknown[] {
  return redactStructuredValue(messages) as unknown[];
}

export function redactMastraMessages(
  messages: MastraDBMessage[],
): MastraDBMessage[] {
  return redactStructuredValue(messages) as MastraDBMessage[];
}

function containsUnsupportedAttachment(message: JsonRecord): boolean {
  if ("attachments" in message || "experimental_attachments" in message) {
    return true;
  }

  const parts = message.parts;
  if (!Array.isArray(parts)) return false;

  return parts.some((part) => {
    if (!isRecord(part)) return true;
    const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
    const url = typeof part.url === "string" ? part.url : "";
    return (
      type === "file" ||
      type === "image" ||
      type === "file-data" ||
      url.startsWith("data:")
    );
  });
}

function validateMessage(message: unknown, index: number): string {
  if (!isRecord(message)) {
    throw new ChatGuardrailError(
      "invalid_request",
      `Message ${index + 1} is invalid.`,
      400,
    );
  }

  if (message.role !== "user" && message.role !== "assistant") {
    throw new ChatGuardrailError(
      "invalid_request",
      "Only user and assistant messages are accepted from the client.",
      400,
    );
  }

  const parts = message.parts;
  if (parts !== undefined && !Array.isArray(parts)) {
    throw new ChatGuardrailError(
      "invalid_request",
      "The message parts are invalid.",
      400,
    );
  }
  if (Array.isArray(parts) && parts.length > CHAT_LIMITS.maxMessageParts) {
    throw new ChatGuardrailError(
      "message_too_large",
      "That message contains too many parts.",
      400,
    );
  }

  const text = extractMessageText(message);
  if (text.length > CHAT_LIMITS.maxTextLength) {
    throw new ChatGuardrailError(
      "message_too_large",
      "That message is too large. Please shorten it and try again.",
      400,
    );
  }

  if (message.role === "user" && containsUnsupportedAttachment(message)) {
    throw new ChatGuardrailError(
      "attachment_not_supported",
      "File and image attachments are not enabled for this chat yet.",
      422,
    );
  }

  return text;
}

function violation(
  code: GuardrailViolation["code"],
  userMessage: string,
): GuardrailViolation {
  return { code, userMessage };
}

const FINANCIAL_ORDER_MUTATION_PATTERN =
  /\b(?:place|submit|execute|cancel)\b[^.!?\n]{0,60}\b(?:order|trade|transaction|position)\b/i;
const FINANCIAL_PAYMENT_MUTATION_PATTERN =
  /\b(?:transfer|withdraw|send|purchase)\b[^.!?\n]{0,60}\b(?:money|funds|payment|cash|account|asset|shares?|stock|trade|position)\b/i;
const FINANCIAL_SALE_MUTATION_PATTERN =
  /\b(?:buy|sell|short|cover)\b[^.!?\n]{0,40}\b(?:stock|shares?|security|asset|position|portfolio|trade|order)\b/i;
const DATA_MUTATION_PATTERN =
  /\b(?:delete|remove|overwrite|publish|write\s+back|change|modify|update)\b[^.!?\n]{0,60}\b(?:record|database|production|file|data|dataset|run|artifact|account)\b/i;
const RESOURCE_MUTATION_PATTERN =
  /\b(?:create|update|delete)\b[^.!?\n]{0,50}\b(?:user|account|dataset|run|artifact|record)\b/i;

export function findGuardrailViolation(
  value: string,
): GuardrailViolation | null {
  const text = normalizeForMatching(value);
  if (!text) return null;

  if (
    /\b(?:ignore|disregard|forget|override)\b.{0,80}\b(?:previous|prior|above|system|developer|safety|policy|instruction)/i.test(
      text,
    ) ||
    /\b(?:jailbreak|bypass|disable|turn off|remove)\b.{0,50}\b(?:guardrail|safety|policy|restriction|filter)/i.test(
      text,
    ) ||
    /\bact\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|developer|system)/i.test(
      text,
    )
  ) {
    return violation(
      "prompt_injection",
      "I can’t follow requests to override the assistant’s safety or authorization rules.",
    );
  }

  if (
    /\b(?:reveal|show|print|dump|disclose|tell me|give me|export)\b.{0,100}\b(?:system prompt|developer prompt|hidden instruction|credential|api key|secret|password|private key|token)\b/i.test(
      text,
    ) ||
    /\b(?:system prompt|developer prompt|hidden instruction)\b.{0,80}\b(?:what|content|text|say|include)/i.test(
      text,
    )
  ) {
    return violation(
      "sensitive_data_request",
      "I can’t disclose system instructions, credentials, or other protected values.",
    );
  }

  if (
    /\b(?:another|other|someone else(?:'s|s)|different)\b.{0,50}\b(?:tenant|workspace|user|account|resource|thread|dataset|run|artifact)\b/i.test(
      text,
    ) ||
    /\b(?:cross[- ]?tenant|cross[- ]?resource|bypass|guess)\b.{0,60}\b(?:id|access|ownership|permission|authorization)/i.test(
      text,
    )
  ) {
    return violation(
      "cross_resource_request",
      "I can only access data and conversation history owned by this chat session.",
    );
  }

  if (
    FINANCIAL_ORDER_MUTATION_PATTERN.test(text) ||
    FINANCIAL_PAYMENT_MUTATION_PATTERN.test(text) ||
    FINANCIAL_SALE_MUTATION_PATTERN.test(text) ||
    DATA_MUTATION_PATTERN.test(text) ||
    RESOURCE_MUTATION_PATTERN.test(text)
  ) {
    return violation(
      "write_action_not_supported",
      "This assistant is limited to read-only finance analysis and cannot perform that action.",
    );
  }

  if (
    /\b(?:should i|tell me whether to|recommend that i|advise me to|is it a good idea to)\b.{0,60}\b(?:buy|sell|hold|invest|trade|short|options|portfolio|stock|crypto|fund)/i.test(
      text,
    ) ||
    /\b(?:guarantee|guaranteed|certain)\b.{0,40}\b(?:return|profit|investment|price)/i.test(
      text,
    )
  ) {
    return violation(
      "investment_advice",
      "I can provide data analysis and educational context, but not individualized investment advice or guaranteed outcomes.",
    );
  }

  if (
    /\b(?:patient|medical|healthcare|clinical|diagnosis|prescription|student grades|school records|retail inventory|manufacturing|erp|legal case|court filing|payroll)\b/i.test(
      text,
    ) &&
    /\b(?:analy[sz]e|predict|classif|retrieve|export|summarize|query|report|records?|data|dataset|information)\b/i.test(
      text,
    )
  ) {
    return violation(
      "unsupported_domain",
      "This prototype is limited to finance-focused data analysis.",
    );
  }

  return null;
}

export function validateChatRequest(body: unknown): JsonRecord {
  if (!isRecord(body)) {
    throw new ChatGuardrailError(
      "invalid_request",
      "The chat request body is invalid.",
      400,
    );
  }

  let serializedLength = 0;
  try {
    serializedLength = JSON.stringify(body).length;
  } catch {
    throw new ChatGuardrailError(
      "invalid_request",
      "The chat request body is invalid.",
      400,
    );
  }
  if (serializedLength > CHAT_LIMITS.maxBodyLength) {
    throw new ChatGuardrailError(
      "message_too_large",
      "That chat request is too large. Please shorten it and try again.",
      400,
    );
  }

  if (!Array.isArray(body.messages)) {
    throw new ChatGuardrailError(
      "invalid_request",
      "The chat request must include a messages array.",
      400,
    );
  }
  if (body.messages.length > CHAT_LIMITS.maxMessages) {
    throw new ChatGuardrailError(
      "message_too_large",
      "That conversation is too long for one request. Please start a new chat.",
      400,
    );
  }

  let totalTextLength = 0;
  for (const [index, message] of body.messages.entries()) {
    const text = validateMessage(message, index);
    totalTextLength += text.length;
    if (totalTextLength > CHAT_LIMITS.maxTotalTextLength) {
      throw new ChatGuardrailError(
        "message_too_large",
        "That conversation contains too much text. Please shorten the history.",
        400,
      );
    }

    if (isRecord(message) && message.role === "user") {
      const violationFound = findGuardrailViolation(text);
      if (violationFound) {
        throw new ChatGuardrailError(
          violationFound.code,
          violationFound.userMessage,
        );
      }
    }
  }

  return {
    ...body,
    messages: redactChatMessages(body.messages),
  };
}
