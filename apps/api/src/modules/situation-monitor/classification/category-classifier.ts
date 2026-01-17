import {
  CATEGORY_TAG_PREFIX,
  SITUATION_MONITOR_CATEGORIES,
  type SituationMonitorCategory,
} from "../situation-monitor.constants";

export enum SituationMonitorCategoryClassificationSource {
  Tag = "tag",
  ResultCategory = "result-category",
  ResultTopics = "result-topics",
  RawTags = "raw-tags",
  Heuristic = "heuristic",
}

export interface SituationMonitorCategoryClassificationResult {
  category: SituationMonitorCategory | null;
  source: SituationMonitorCategoryClassificationSource | null;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    out.push(trimmed);
  }
  return out;
}

function extractRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractCategoryFromTags(tags: unknown): SituationMonitorCategory | null {
  if (!Array.isArray(tags)) {
    return null;
  }
  for (const tag of tags) {
    if (typeof tag !== "string") {
      continue;
    }
    if (!tag.startsWith(CATEGORY_TAG_PREFIX)) {
      continue;
    }
    const category = tag.slice(CATEGORY_TAG_PREFIX.length).trim().toLowerCase();
    if ((SITUATION_MONITOR_CATEGORIES as readonly string[]).includes(category)) {
      return category as SituationMonitorCategory;
    }
  }
  return null;
}

function mapLabelToCategory(raw: string): SituationMonitorCategory | null {
  const normalized = normalizeText(raw);
  if (!normalized) {
    return null;
  }
  if ((SITUATION_MONITOR_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as SituationMonitorCategory;
  }

  const mappings: Array<{ pattern: RegExp; category: SituationMonitorCategory }> = [
    { pattern: /\b(ai|artificial intelligence|llm|gpt)\b/i, category: "ai" },
    { pattern: /\b(intel|intelligence|osint|defense|military|security|cyber)\b/i, category: "intel" },
    { pattern: /\b(gov|government|policy|regulation|regulatory|agency)\b/i, category: "gov" },
    { pattern: /\b(finance|financial|markets?|economy|economic|stocks?|equities?)\b/i, category: "finance" },
    { pattern: /\b(tech|technology|software|hardware|semiconductor|chips?)\b/i, category: "tech" },
    { pattern: /\b(politics?|geopolitics?|diplomacy|election)\b/i, category: "politics" },
  ];

  for (const mapping of mappings) {
    if (mapping.pattern.test(normalized)) {
      return mapping.category;
    }
  }

  return null;
}

function findFirstCategory(values: string[]): SituationMonitorCategory | null {
  for (const value of values) {
    const mapped = mapLabelToCategory(value);
    if (mapped) {
      return mapped;
    }
  }
  return null;
}

function classifyFromText(text: string): SituationMonitorCategory | null {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  const rules: Array<{ pattern: RegExp; category: SituationMonitorCategory }> = [
    {
      pattern: /\b(openai|anthropic|deepmind|chatgpt|gpt-?\d|llm|agi|artificial intelligence)\b/i,
      category: "ai",
    },
    {
      pattern: /\b(federal reserve|fomc|sec\b|white house|congress|senate|supreme court|doj|treasury|regulation|regulatory)\b/i,
      category: "gov",
    },
    {
      pattern: /\b(nasdaq|s&p|dow|earnings|bond|yield|inflation|cpi|gdp|recession|market|equity|stock|bitcoin|btc|ethereum|eth|crypto)\b/i,
      category: "finance",
    },
    {
      pattern: /\b(cyber|osint|pentagon|cia|nsa|fbi|defense|missile|airstrike|drone|munitions)\b/i,
      category: "intel",
    },
    {
      pattern: /\b(semiconductor|chip|apple|google|microsoft|meta|startup|cloud|software|hardware)\b/i,
      category: "tech",
    },
    {
      pattern: /\b(election|campaign|parliament|sanction|ukraine|russia|israel|gaza|china|taiwan|iran|nato|ceasefire)\b/i,
      category: "politics",
    },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(normalized)) {
      return rule.category;
    }
  }

  return null;
}

export function classifySituationMonitorCategory(input: {
  tags: unknown;
  result: unknown;
  rawTags: unknown;
  title: string;
  summary?: string | null;
  source?: string | null;
}): SituationMonitorCategoryClassificationResult {
  const tagCategory = extractCategoryFromTags(input.tags);
  if (tagCategory) {
    return { category: tagCategory, source: SituationMonitorCategoryClassificationSource.Tag };
  }

  const resultRecord = extractRecord(input.result);
  const rawCategory = typeof resultRecord?.category === "string" ? resultRecord.category : null;
  if (rawCategory) {
    const mapped = mapLabelToCategory(rawCategory);
    if (mapped) {
      return { category: mapped, source: SituationMonitorCategoryClassificationSource.ResultCategory };
    }
  }

  const rawTopics = toStringArray(resultRecord?.topics);
  const topicsCategory = findFirstCategory(rawTopics);
  if (topicsCategory) {
    return { category: topicsCategory, source: SituationMonitorCategoryClassificationSource.ResultTopics };
  }

  const rawTagList = toStringArray(input.rawTags);
  const rawTagsCategory = findFirstCategory(rawTagList);
  if (rawTagsCategory) {
    return { category: rawTagsCategory, source: SituationMonitorCategoryClassificationSource.RawTags };
  }

  const text = `${input.title} ${input.summary ?? ""} ${input.source ?? ""}`;
  const heuristicCategory = classifyFromText(text);
  if (heuristicCategory) {
    return { category: heuristicCategory, source: SituationMonitorCategoryClassificationSource.Heuristic };
  }

  return { category: null, source: null };
}

