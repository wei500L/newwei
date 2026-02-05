export enum SearchSentiment {
  Positive = "positive",
  Neutral = "neutral",
  Negative = "negative"
}

export interface SearchSyntaxResult {
  topic?: string;
  region?: string;
  sentiment?: SearchSentiment;
  from?: string;
  to?: string;
  source?: string;
  phrase?: string;
  remainingText?: string;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parts = value.split("-");
  if (parts.length !== 3) {
    return false;
  }
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return false;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parseSentiment(value: string): SearchSentiment | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === SearchSentiment.Positive) {
    return SearchSentiment.Positive;
  }
  if (normalized === SearchSentiment.Neutral) {
    return SearchSentiment.Neutral;
  }
  if (normalized === SearchSentiment.Negative) {
    return SearchSentiment.Negative;
  }
  return null;
}

export function parseSearchSyntax(input: string): SearchSyntaxResult {
  const result: SearchSyntaxResult = {};
  const remainingTokens: string[] = [];

  const text = input.trim();
  if (!text) {
    return result;
  }

  const len = text.length;
  let idx = 0;

  const isWhitespace = (ch: string) => /\s/.test(ch);

  const skipWhitespace = () => {
    while (idx < len && isWhitespace(text[idx]!)) {
      idx += 1;
    }
  };

  const readQuoted = () => {
    idx += 1; // opening quote
    let out = "";
    while (idx < len) {
      const ch = text[idx]!;
      if (ch === "\\") {
        const next = text[idx + 1];
        if (next) {
          out += next;
          idx += 2;
          continue;
        }
        idx += 1;
        continue;
      }
      if (ch === "\"") {
        idx += 1;
        break;
      }
      out += ch;
      idx += 1;
    }
    return out;
  };

  const readBare = () => {
    const start = idx;
    while (idx < len && !isWhitespace(text[idx]!)) {
      idx += 1;
    }
    return text.slice(start, idx);
  };

  while (idx < len) {
    skipWhitespace();
    if (idx >= len) {
      break;
    }

    if (text[idx] === "\"") {
      const phrase = readQuoted().trim();
      if (!phrase) {
        continue;
      }
      if (!result.phrase) {
        result.phrase = phrase;
      } else {
        remainingTokens.push(`"${phrase}"`);
      }
      continue;
    }

    const fieldStart = idx;
    while (idx < len && !isWhitespace(text[idx]!) && text[idx] !== ":") {
      idx += 1;
    }

    if (idx < len && text[idx] === ":") {
      const fieldRaw = text.slice(fieldStart, idx);
      idx += 1; // colon
      skipWhitespace();

      const quotedValue = idx < len && text[idx] === "\"";
      const valueRaw = quotedValue ? readQuoted() : readBare();

      const field = fieldRaw.trim().toLowerCase();
      const value = valueRaw.trim();
      if (!value) {
        remainingTokens.push(`${fieldRaw}:`);
        continue;
      }

      const pushRemaining = () => {
        remainingTokens.push(quotedValue ? `${fieldRaw}:"${value}"` : `${fieldRaw}:${value}`);
      };

      if (field === "topic") {
        result.topic = value;
        continue;
      }
      if (field === "region") {
        result.region = value;
        continue;
      }
      if (field === "source") {
        result.source = value;
        continue;
      }
      if (field === "sentiment") {
        const sentiment = parseSentiment(value);
        if (!sentiment) {
          pushRemaining();
          continue;
        }
        result.sentiment = sentiment;
        continue;
      }
      if (field === "from") {
        if (!isValidIsoDate(value)) {
          pushRemaining();
          continue;
        }
        result.from = value;
        continue;
      }
      if (field === "to") {
        if (!isValidIsoDate(value)) {
          pushRemaining();
          continue;
        }
        result.to = value;
        continue;
      }

      pushRemaining();
      continue;
    }

    idx = fieldStart;
    const token = readBare().trim();
    if (token) {
      remainingTokens.push(token);
    }
  }

  const remainingText = remainingTokens.join(" ").trim();
  if (remainingText) {
    result.remainingText = remainingText;
  }

  return result;
}
