export interface OpenAiContentPart {
  type?: unknown;
  text?: unknown;
  refusal?: unknown;
  [key: string]: unknown;
}

function normalizeNonEmptyString(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trimEnd();
  return value.length > 0 ? value : null;
}

function extractTextFromContentPart(part: unknown): string | null {
  if (typeof part === "string") {
    return part;
  }
  if (!part || typeof part !== "object") {
    return null;
  }
  const record = part as OpenAiContentPart;
  return normalizeNonEmptyString(record.text) ?? normalizeNonEmptyString(record.refusal);
}

export function extractOpenAiTextFromContent(content: unknown): string | null {
  const direct = normalizeNonEmptyString(content);
  if (direct !== null) {
    return direct;
  }
  if (content === null) {
    return null;
  }
  if (Array.isArray(content)) {
    const combined = content
      .map(extractTextFromContentPart)
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .join("");
    const trimmed = combined.trim();
    return trimmed.length > 0 ? combined : null;
  }
  if (content && typeof content === "object") {
    return extractTextFromContentPart(content);
  }
  return null;
}

export function extractOpenAiTextFromChoice(choice: unknown): string | null {
  if (!choice || typeof choice !== "object") {
    return null;
  }

  const record = choice as Record<string, unknown>;
  const message = record.message;
  if (typeof message === "string") {
    return extractOpenAiTextFromContent(message);
  }
  if (message && typeof message === "object") {
    const messageRecord = message as Record<string, unknown>;
    const content = extractOpenAiTextFromContent(messageRecord.content);
    if (content !== null) {
      return content;
    }
    const refusal = extractOpenAiTextFromContent(messageRecord.refusal);
    if (refusal !== null) {
      return refusal;
    }
  }

  const delta = record.delta;
  if (delta && typeof delta === "object") {
    const deltaRecord = delta as Record<string, unknown>;
    const content = extractOpenAiTextFromContent(deltaRecord.content);
    if (content !== null) {
      return content;
    }
  }

  return extractOpenAiTextFromContent(record.text);
}

