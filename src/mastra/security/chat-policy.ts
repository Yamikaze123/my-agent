import type { MastraDBMessage } from "@mastra/core/agent/message-list";

export const CHAT_POLICY_VERSION = "2026-10-04";

export const CHAT_LIMITS = {
  maxMessages: 24,
  maxMessageParts: 32,
  maxTextLength: 12_000,
  maxTotalTextLength: 48_000,
  maxBodyLength: 500_000,
  // The browser sends one new user message per request; the server's memory
  // supplies the history. This leaves ample room for that message while
  // refusing to buffer an arbitrarily large upload.
  maxRequestBytes: 262_144,
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
  readonly status: 400 | 413 | 422;
  readonly userMessage: string;

  constructor(
    code: ChatGuardrailCode,
    userMessage: string,
    status: 400 | 413 | 422 = 422,
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
  if (depth > 8 || value === null || value === undefined) return "";
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
    "rows",
    "data",
    "reasoning",
    "toolInvocation",
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

// Payment-card candidates: 13-19 digits, either contiguous or in groups
// separated by one space or hyphen. The surrounding lookarounds keep the
// match out of decimals, thousands-separated figures, and longer identifiers,
// and the Luhn check below rejects ordinary numeric output such as dates,
// volumes, and float digits that only happen to be long.
const CARD_CANDIDATE_PATTERN =
  /(?<![\w.,\-/])\d(?:[ -]?\d){12,18}(?![\w\-/]|[.,]\d)/g;

function passesLuhnCheck(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasCardGrouping(candidate: string): boolean {
  if (/^\d+$/.test(candidate)) return true;
  // Separated candidates must use one consistent separator and card-like
  // groups (for example 4-4-4-4 or 4-6-5). Whitespace-aligned numeric tables
  // and date sequences do not have that shape.
  const separators = new Set(candidate.replace(/\d/g, "").split(""));
  if (separators.size !== 1) return false;
  const groups = candidate.split(/[ -]/);
  return (
    groups.length >= 3 &&
    groups.length <= 5 &&
    groups[0].length === 4 &&
    groups.every((group) => group.length >= 2 && group.length <= 7)
  );
}

function redactCardNumbers(value: string): string {
  return value.replace(CARD_CANDIDATE_PATTERN, (candidate) => {
    const digits = candidate.replace(/\D/g, "");
    return hasCardGrouping(candidate) && passesLuhnCheck(digits)
      ? "[REDACTED_CARD]"
      : candidate;
  });
}

// Phone numbers must be written like phone numbers: an international prefix,
// a parenthesized area code, or hyphen/period separators. A bare run of ten
// digits is far more often a volume or a market capitalization.
//
// The space-separated form ("212 555 0199") is also redacted, but it looks
// exactly like three adjacent figures in printed output, so it is matched
// only when it stands alone: single spaces, no number immediately before or
// after it, and an area code and exchange that begin with 2-9 as real North
// American numbers do. A row of statistics has neighbours or wider spacing
// and is left intact; an isolated triple that happens to fit is redacted.
const PHONE_PATTERNS: readonly RegExp[] = [
  /(?<![\w.])\+\d{1,3}[\s.-]?(?:\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}(?![\w-]|\.\d)/g,
  /(?<![\w.])\(\d{3}\)\s?\d{3}[\s.-]?\d{4}(?![\w-]|\.\d)/g,
  /(?<![\w.\-/])\d{3}-\d{3}-\d{4}(?![\w\-/]|\.\d)/g,
  /(?<![\w.\-/])\d{3}\.\d{3}\.\d{4}(?![\w\-/]|\.\d)/g,
  /(?<![\w.\-/]|\d\s+)[2-9]\d{2} [2-9]\d{2} \d{4}(?![\w\-/]|\.\d|\s+\d)/g,
];

function redactPhoneNumbers(value: string): string {
  return PHONE_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[REDACTED_PHONE]"),
    value,
  );
}

export function redactSensitiveText(value: string): string {
  return redactPhoneNumbers(
    redactCardNumbers(
      redactApiKeyAndToken(value).replace(
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        "[REDACTED_EMAIL]",
      ),
    ),
  ).replace(/(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/g, "[REDACTED_SSN]");
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

const MAX_MODEL_HISTORY_OUTPUT_LENGTH = 8_000;

function truncateModelHistory(value: string): string {
  if (value.length <= MAX_MODEL_HISTORY_OUTPUT_LENGTH) return value;
  return `${value.slice(0, MAX_MODEL_HISTORY_OUTPUT_LENGTH)}\n[truncated before being sent to the model]`;
}

/**
 * Replace image payloads with a count and bound stdout/stderr text anywhere in
 * a structured value. Shared by model-history compaction and trace export so
 * base64 image bytes never reach the model context or persisted spans.
 */
export function compactLargeToolPayload(value: unknown): unknown {
  return compactModelHistory(value);
}

function compactModelHistory(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(compactModelHistory);
  if (value === null || typeof value !== "object") return value;

  const record = value as JsonRecord;
  const compacted: JsonRecord = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "images" && Array.isArray(child)) {
      compacted.images = [];
      compacted.imageCount = child.length;
      continue;
    }
    if ((key === "stdout" || key === "stderr") && typeof child === "string") {
      compacted[key] = truncateModelHistory(child);
      continue;
    }
    compacted[key] = compactModelHistory(child);
  }
  return compacted;
}

export function redactMastraMessages(
  messages: MastraDBMessage[],
): MastraDBMessage[] {
  return compactModelHistory(
    redactStructuredValue(messages),
  ) as MastraDBMessage[];
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

// The request-intent rules below are deliberately narrow. Finance analysis
// language routinely contains words such as "change", "remove", "short",
// "token", "different", and "payroll"; a rule must describe a request for a
// prohibited action, not merely contain one of those words.

const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b.{0,60}\b(?:instructions?|prompts?|rules|guardrails?|safety|restrictions?|(?:system|developer)\s+messages?|(?:safety|system|content|usage|your)\s+polic(?:y|ies))\b/i,
  /\bjailbreak\b/i,
  /\b(?:bypass|disable|turn off|remove|circumvent)\b.{0,50}\b(?:guardrails?|safety|restrictions?|(?:content|safety)\s+filters?|(?:safety|system|content|usage)\s+polic(?:y|ies))\b/i,
  /\bact\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|developer|system)\b/i,
];

const PROTECTED_VALUE_TERMS =
  "system prompts?|developer prompts?|hidden instructions?|credentials?|api[ _-]?keys?|secret[ _-]?keys?|client secrets?|your secrets?|passwords?|private keys?|(?:api|access|auth|bearer|session|refresh)[ _-]tokens?|environment variables";

const SENSITIVE_DATA_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `\\b(?:reveal|show|print|dump|disclose|tell me|give me|export|leak|output)\\b.{0,100}\\b(?:${PROTECTED_VALUE_TERMS})\\b`,
    "i",
  ),
  /\b(?:system prompt|developer prompt|hidden instructions?)\b.{0,80}\b(?:what|content|text|say|include)/i,
  /\b(?:scan|search|read|list)\b.{0,60}\b(?:filesystem|file system)\b.{0,40}\b(?:secrets?|credentials?|keys?|passwords?)\b/i,
];

const CROSS_RESOURCE_PATTERNS: readonly RegExp[] = [
  // Another party's data. "Another dataset" or "a different ticker" in the
  // caller's own workspace is ordinary analysis language and is not matched.
  /\b(?:another|other|different|someone else(?:'s|s)?|somebody else(?:'s|s)?)\s+(?:tenant|workspace|user|customer|person|account|session)(?:'s|s'|s)?\b/i,
  /\b(?:cross[- ]?tenant|cross[- ]?resource)\b/i,
  /\b(?:bypass|guess|forge|spoof)\b.{0,60}\b(?:ownership|permissions?|authorization|access controls?|(?:dataset|thread|resource|run|tenant|session)\s+ids?)\b/i,
];

const FINANCIAL_ORDER_MUTATION_PATTERN =
  /\b(?:place|submit|execute|cancel)\b[^.!?\n]{0,60}\b(?:orders?|trades?|transactions?)\b/i;
const FINANCIAL_PAYMENT_MUTATION_PATTERN =
  /\b(?:transfer|withdraw|wire|send|deposit)\b[^.!?\n]{0,40}\b(?:money|funds|payments?|cash)\b|\b(?:transfer|withdraw)\b[^.!?\n]{0,60}\b(?:from|to|into)\b[^.!?\n]{0,30}\baccounts?\b/i;
// An instruction to trade on the caller's behalf, as opposed to a question
// about buying, selling, or short positions. A quantity alone is not enough:
// "how many investors buy 100 shares at a time?" and "a strategy to buy 10
// stocks each month" are analysis. An order must be phrased as an instruction,
// at the start of a sentence or after a request phrase.
const ORDER_INSTRUCTION_PREFIX = String.raw`(?:^|[.!?;:]\s*|\b(?:please|kindly|now|then|and|just|go ahead and|can you|could you|will you|help me|i want you to|i(?:['’]d| would)? (?:want|like|need) to|let['’]?s)\s+)`;
const ORDER_VERB = String.raw`(?:buy|sell|short|purchase)\s+(?:me\s+)?`;

const FINANCIAL_SALE_MUTATION_PATTERNS: readonly RegExp[] = [
  // "Sell 100 shares of TSLA", "buy some shares", "sell all my holdings".
  new RegExp(
    ORDER_INSTRUCTION_PREFIX +
      ORDER_VERB +
      String.raw`(?:\d[\d,.]*\s+|some\s+|all\s+(?:of\s+)?(?:my\s+)?|my\s+)(?:\w+\s+){0,2}(?:shares?|stocks?|units?|positions?|holdings?|contracts?)\b`,
    "i",
  ),
  // A quantity and a symbol: "buy 10 TSLA", "I want to buy $500 of AAPL".
  // The word after the quantity must be symbol-shaped rather than a unit.
  new RegExp(
    ORDER_INSTRUCTION_PREFIX +
      ORDER_VERB +
      String.raw`\$?\s?\d[\d,.]*k?\s+(?:(?:dollars?|usd)\s+)?(?:worth\s+)?(?:of\s+)?(?!(?:days?|weeks?|month|years?|times|more|each|per|of|to|in|at|and|or|bps|pct|sma|ema|dma|x)\b)[a-z]{1,5}(?:[.\-][a-z]{1,2})?\b`,
    "i",
  ),
  // Acting for the caller, wherever it appears in the sentence.
  /\b(?:buy|sell|short|purchase|trade)\b[^.!?\n]{0,60}\b(?:for me|on my behalf|(?:in|from|with)\s+my\s+(?:brokerage\s+)?account)\b/i,
  // An urgent order: "sell shares immediately".
  /\b(?:buy|sell|short|purchase)\s+(?:\w+\s+){0,3}(?:shares?|stocks?|holdings?|positions?)\s+(?:now|immediately|today|right away|asap|at market)\b/i,
];
const DATA_DESTRUCTION_PATTERN =
  /\b(?:delete|overwrite|publish|write\s+back|wipe|erase)\b[^.!?\n]{0,60}\b(?:records?|databases?|production|files?|datasets?|artifacts?|accounts?|uploads?)\b/i;
// "Change", "modify", "update", and "remove" are analysis words unless they
// target a system of record.
const SYSTEM_OF_RECORD_MUTATION_PATTERN =
  /\b(?:change|modify|update|remove|edit|alter)\b[^.!?\n]{0,40}\b(?:production|databases?|system of record|(?:stored|registered|source|original|catalog)\s+(?:data|datasets?|records?|files?)|account\s+(?:settings|details|balance))\b/i;
const RESOURCE_MUTATION_PATTERN =
  /\b(?:create|register|update|delete)\s+(?:(?:a|an|the|my|another)\s+)?(?:new\s+)?(?:user|account|tenant|workspace)s?\b/i;
const APPROVAL_BYPASS_PATTERN =
  /\b(?:mark|set|flag)\b[^.!?\n]{0,40}\bapproval\b[^.!?\n]{0,30}\b(?:complete|completed|approved|granted)\b|\bwithout\s+(?:review|approval)\b/i;
const SHELL_EXECUTION_PATTERN =
  /\b(?:run|execute)\b[^.!?\n]{0,30}\b(?:shell|bash|terminal|system)\s+commands?\b/i;

const INVESTMENT_ADVICE_PATTERNS: readonly RegExp[] = [
  /\b(?:should i|tell me whether to|recommend that i|advise me to|is it a good idea to|do you think i should)\b.{0,60}\b(?:buy|sell|hold|invest|short|trade)\b/i,
  /\b(?:tell me|recommend|pick|choose)\b.{0,40}\b(?:which|what)\s+(?:stocks?|shares?|funds?|etfs?|crypto\w*|coins?|securit(?:y|ies)|assets?)\b.{0,20}\b(?:to\s+)?(?:buy|sell|invest|short)\b/i,
  /\bhow much\b.{0,40}\b(?:should i|of my|to)\b.{0,30}\b(?:invest|buy)\b/i,
  /\b(?:give|find|show|pick|recommend|want|need|for)\b.{0,40}\bguaranteed?\b.{0,20}\b(?:returns?|profits?|gains?|winners?)\b/i,
];

const UNSUPPORTED_DOMAIN_SUBJECT_PATTERN =
  /\b(?:patients?|medical\s+(?:records?|conditions?|histor(?:y|ies)|files?|data|charts?)|health\s+(?:files?|records?)|clinical\s+(?:records?|notes|data)|diagnos(?:e|is|es|tic)|prescriptions?|student grades|school records|retail inventory|manufacturing\s+(?:erp|records?)|erp\s+(?:system|records?|data)|legal case|court filing|payroll\s+(?:records?|system))\b/i;
const UNSUPPORTED_DOMAIN_ACTION_PATTERN =
  /\b(?:analy[sz]e|predict|classif|retrieve|export|summarize|query|report|records?|data|dataset|information|diagnos)/i;

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Classify request intent in user-authored text (and, for flagging only,
 * untrusted tool or dataset values). This must not be applied to the
 * assistant's own answers; use findOutputViolation for generated text.
 */
export function findGuardrailViolation(
  value: string,
): GuardrailViolation | null {
  const text = normalizeForMatching(value);
  if (!text) return null;

  if (matchesAny(PROMPT_INJECTION_PATTERNS, text)) {
    return violation(
      "prompt_injection",
      "I can’t follow requests to override the assistant’s safety or authorization rules.",
    );
  }

  if (matchesAny(SENSITIVE_DATA_PATTERNS, text)) {
    return violation(
      "sensitive_data_request",
      "I can’t disclose system instructions, credentials, or other protected values.",
    );
  }

  if (matchesAny(CROSS_RESOURCE_PATTERNS, text)) {
    return violation(
      "cross_resource_request",
      "I can only access data and conversation history owned by this chat session.",
    );
  }

  if (
    FINANCIAL_ORDER_MUTATION_PATTERN.test(text) ||
    FINANCIAL_PAYMENT_MUTATION_PATTERN.test(text) ||
    matchesAny(FINANCIAL_SALE_MUTATION_PATTERNS, text) ||
    DATA_DESTRUCTION_PATTERN.test(text) ||
    SYSTEM_OF_RECORD_MUTATION_PATTERN.test(text) ||
    RESOURCE_MUTATION_PATTERN.test(text) ||
    APPROVAL_BYPASS_PATTERN.test(text) ||
    SHELL_EXECUTION_PATTERN.test(text)
  ) {
    return violation(
      "write_action_not_supported",
      "This assistant is limited to read-only finance analysis and cannot perform that action.",
    );
  }

  if (matchesAny(INVESTMENT_ADVICE_PATTERNS, text)) {
    return violation(
      "investment_advice",
      "I can provide data analysis and educational context, but not individualized investment advice or guaranteed outcomes.",
    );
  }

  if (
    UNSUPPORTED_DOMAIN_SUBJECT_PATTERN.test(text) &&
    UNSUPPORTED_DOMAIN_ACTION_PATTERN.test(text)
  ) {
    return violation(
      "unsupported_domain",
      "This prototype is limited to finance-focused data analysis.",
    );
  }

  return null;
}

// Generated text is checked for what the assistant itself must not say:
// individualized trade instructions and promised outcomes. Request-intent
// rules do not apply here, because a correct analysis summary naturally
// mentions price changes, other datasets, and the absence of guarantees.
const OUTPUT_ADVICE_PATTERNS: readonly RegExp[] = [
  /\b(?:you should|you ought to|you need to|i (?:would )?(?:recommend|advise|suggest)(?: that)? you|my (?:recommendation|advice) is(?: for you)? to)\s+(?:definitely\s+|now\s+|immediately\s+)?(?:buy|sell|short|invest in|invest|dump|load up on|hold (?:on to|onto)?)\b/i,
  /\bi (?:recommend|advise|suggest) (?:buying|selling|shorting|investing in)\b/i,
  // Softer phrasings of the same thing, still addressed to the reader or
  // stated as the assistant's own trade.
  /\byou (?:may|might|could|should|would|will)\s+(?:(?:really|probably|definitely)\s+)?(?:want|wish|like|do well|be wise|be smart)\s+to\s+(?:consider\s+)?(?:buy|sell|short|invest|dump|hold|load up on|buying|selling|shorting|investing)\b/i,
  /\byou (?:may|might|could|should)\s+(?:want to\s+)?consider\s+(?:buying|selling|shorting|investing in|holding)\b/i,
  /\byou(?:['’]d| would) be (?:wise|smart|better off)\s+(?:to\s+)?(?:buy|sell|short|invest|hold|buying|selling|shorting|investing|holding)\b/i,
  /\bi(?:['’]d| would| wouldn['’]t| would not)\s+(?:(?:definitely|personally|probably|absolutely)\s+)?(?:buy|sell|short|hold|invest in|avoid|stay away from|load up on|dump)\b/i,
  /\bif i were you\b.{0,60}\b(?:buy|sell|short|hold|invest|avoid)\b|\b(?:buy|sell|short|hold|invest|avoid)\b.{0,60}\bif i were you\b/i,
  /\b(?:now is|it(?:['’]s| is)) (?:a |the )?(?:good|great|perfect|right|bad|terrible) time to (?:buy|sell|short|invest)\b/i,
];
const OUTPUT_GUARANTEE_PATTERNS: readonly RegExp[] = [
  /\b(?:is|are|will be)\s+guaranteed\s+to\s+(?:rise|increase|gain|grow|profit|go up|double|outperform|recover)\b/i,
  /\b(?:i|we)\s+guarantee\b.{0,40}\b(?:returns?|profits?|gains?)\b/i,
  /\b(?:will|is going to)\s+(?:definitely|certainly)\s+(?:rise|increase|go up|double|outperform)\b/i,
];

export function findOutputViolation(value: string): GuardrailViolation | null {
  const text = normalizeForMatching(value);
  if (!text) return null;

  if (
    matchesAny(OUTPUT_ADVICE_PATTERNS, text) ||
    matchesAny(OUTPUT_GUARANTEE_PATTERNS, text)
  ) {
    return violation(
      "investment_advice",
      "I can provide data analysis and educational context, but not individualized investment advice or guaranteed outcomes.",
    );
  }

  return null;
}

/**
 * Reduce a client request to its newest user message. Conversation history is
 * owned by server-side memory, so earlier messages in the request body are
 * ignored: a client cannot supply or rewrite assistant or tool history, and
 * accumulated chart images or tool output cannot push a request over a limit.
 */
export function selectLatestUserMessage(body: unknown): JsonRecord {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    throw new ChatGuardrailError(
      "invalid_request",
      "The chat request must include a messages array.",
      400,
    );
  }

  const latest: unknown = body.messages[body.messages.length - 1];
  if (!isRecord(latest) || latest.role !== "user") {
    throw new ChatGuardrailError(
      "invalid_request",
      "The chat request must end with a user message.",
      400,
    );
  }

  return { messages: [latest] };
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
