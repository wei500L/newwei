export type NewsLegacyCategory =
  | "politics"
  | "tech"
  | "finance"
  | "gov"
  | "ai"
  | "intel";

export interface NewsClassificationTaxonomyNodeInput {
  path: string;
  displayName: string;
  description: string;
  legacyCategory: NewsLegacyCategory;
  keywords: string[];
  synonyms: string[];
}

export type NewsClassificationTaxonomyValidationCode =
  | "invalidJson"
  | "mustBeArray"
  | "minItems"
  | "nodeInvalid";

export interface NewsClassificationTaxonomyValidationError {
  code: NewsClassificationTaxonomyValidationCode;
  field?: string;
  index?: number;
}

export type ParseNewsClassificationTaxonomyResult =
  | { ok: true; taxonomy: NewsClassificationTaxonomyNodeInput[] }
  | { ok: false; error: NewsClassificationTaxonomyValidationError };

const LEGACY_CATEGORIES = new Set<NewsLegacyCategory>([
  "politics",
  "tech",
  "finance",
  "gov",
  "ai",
  "intel",
]);

const asTrimmedString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const validateStringList = (
  value: unknown,
  field: "keywords" | "synonyms",
  index: number,
): string[] | NewsClassificationTaxonomyValidationError => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return { code: "nodeInvalid", field, index };
  }
  const normalized: string[] = [];
  for (const entry of value) {
    const cleaned = asTrimmedString(entry);
    if (!cleaned) {
      return { code: "nodeInvalid", field, index };
    }
    normalized.push(cleaned);
  }
  return normalized;
};

export const parseNewsClassificationTaxonomyJson = (
  raw: string,
): ParseNewsClassificationTaxonomyResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "invalidJson" } };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: { code: "mustBeArray" } };
  }

  if (parsed.length === 0) {
    return { ok: false, error: { code: "minItems" } };
  }

  const taxonomy: NewsClassificationTaxonomyNodeInput[] = [];
  for (let idx = 0; idx < parsed.length; idx += 1) {
    const index = idx + 1;
    const entry = parsed[idx];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: { code: "nodeInvalid", field: "node", index } };
    }
    const record = entry as Record<string, unknown>;

    const path = asTrimmedString(record.path);
    if (!path) {
      return { ok: false, error: { code: "nodeInvalid", field: "path", index } };
    }

    const displayName = asTrimmedString(record.displayName);
    if (!displayName) {
      return {
        ok: false,
        error: { code: "nodeInvalid", field: "displayName", index },
      };
    }

    const description = asTrimmedString(record.description);
    if (!description) {
      return {
        ok: false,
        error: { code: "nodeInvalid", field: "description", index },
      };
    }

    const legacyCategoryRaw = asTrimmedString(record.legacyCategory);
    if (!legacyCategoryRaw) {
      return {
        ok: false,
        error: { code: "nodeInvalid", field: "legacyCategory", index },
      };
    }
    if (!LEGACY_CATEGORIES.has(legacyCategoryRaw as NewsLegacyCategory)) {
      return {
        ok: false,
        error: { code: "nodeInvalid", field: "legacyCategory", index },
      };
    }

    const keywords = validateStringList(record.keywords, "keywords", index);
    if (!Array.isArray(keywords)) {
      return { ok: false, error: keywords };
    }
    const synonyms = validateStringList(record.synonyms, "synonyms", index);
    if (!Array.isArray(synonyms)) {
      return { ok: false, error: synonyms };
    }

    taxonomy.push({
      path,
      displayName,
      description,
      legacyCategory: legacyCategoryRaw as NewsLegacyCategory,
      keywords,
      synonyms,
    });
  }

  return {
    ok: true,
    taxonomy,
  };
};
