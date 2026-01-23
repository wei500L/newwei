export function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) {
    return trimmed;
  }

  const afterFence = trimmed.slice(firstNewline + 1);
  const closingFence = afterFence.lastIndexOf("```");
  if (closingFence === -1) {
    return trimmed;
  }

  return afterFence.slice(0, closingFence).trim();
}

export function extractFirstJson(text: string): string | null {
  const cleaned = stripMarkdownCodeFence(text);
  const startObject = cleaned.indexOf("{");
  const startArray = cleaned.indexOf("[");
  const start =
    startObject === -1
      ? startArray
      : startArray === -1
        ? startObject
        : Math.min(startObject, startArray);
  if (start === -1) {
    return null;
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (!char) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      stack.push("}");
      continue;
    }

    if (char === "[") {
      stack.push("]");
      continue;
    }

    if (char === "}" || char === "]") {
      const expected = stack.pop();
      if (expected && expected !== char) {
        return null;
      }
      if (stack.length === 0) {
        return cleaned.slice(start, index + 1).trim();
      }
    }
  }

  return null;
}

export function safeJsonParseFromText<T>(text: string): T | null {
  const extracted = extractFirstJson(text);
  if (!extracted) {
    return null;
  }
  try {
    return JSON.parse(extracted) as T;
  } catch {
    return null;
  }
}

