import {
  extractCountryCodeFromText,
  getCountryName,
  normalizeCountryCode,
} from '@modular/utils';
import { Injectable } from '@nestjs/common';

import {
  ARCHIVE_RULE_CONFLICT_KEYWORD_PENALTY,
  ARCHIVE_RULE_EXCLUDED_KEYWORD_PENALTY,
  ARCHIVE_RULE_STRONG_KEYWORD_INCREMENT,
  ARCHIVE_RULE_STRONG_SCORE,
  ARCHIVE_RULE_WEAK_KEYWORD_INCREMENT,
} from './archive-classification.constants';
import {
  ARCHIVE_VERTICAL_TAXONOMY,
} from './archive-taxonomy';
import {
  ARCHIVE_VERTICAL_ORDER,
  ArchiveRegion,
  ArchiveVertical,
  type ArchiveVerticalScores,
  createArchiveVerticalScoreMap,
} from './archive.types';

const APAC_COUNTRIES = new Set([
  'AUS',
  'BRN',
  'CHN',
  'IDN',
  'IND',
  'JPN',
  'KHM',
  'KOR',
  'LAO',
  'MMR',
  'MNG',
  'MYS',
  'NZL',
  'PAK',
  'PHL',
  'PRK',
  'SGP',
  'THA',
  'TWN',
  'VNM',
]);

const MIDDLE_EAST_COUNTRIES = new Set([
  'ARE',
  'BHR',
  'EGY',
  'IRN',
  'IRQ',
  'ISR',
  'JOR',
  'KWT',
  'LBN',
  'OMN',
  'PSE',
  'QAT',
  'SAU',
  'SYR',
  'TUR',
  'YEM',
]);

const AMERICAS_COUNTRIES = new Set([
  'ARG',
  'BOL',
  'BRA',
  'CAN',
  'CHL',
  'COL',
  'CUB',
  'ECU',
  'MEX',
  'PER',
  'USA',
  'VEN',
]);

const EUROPE_COUNTRIES = new Set([
  'AUT',
  'BEL',
  'CHE',
  'CZE',
  'DEU',
  'DNK',
  'ESP',
  'FIN',
  'FRA',
  'GBR',
  'GRC',
  'HUN',
  'IRL',
  'ITA',
  'NLD',
  'NOR',
  'POL',
  'PRT',
  'ROU',
  'RUS',
  'SWE',
  'UKR',
]);

const AFRICA_COUNTRIES = new Set([
  'AGO',
  'BWA',
  'CMR',
  'COD',
  'DZA',
  'ETH',
  'GHA',
  'KEN',
  'LBY',
  'MAR',
  'NGA',
  'SDN',
  'SEN',
  'SOM',
  'TUN',
  'UGA',
  'ZAF',
]);

const APAC_KEYWORDS = [
  '亚太',
  'asia pacific',
  'indo-pacific',
  '东亚',
  '东南亚',
  '南亚',
];
const MIDDLE_EAST_KEYWORDS = ['中东', 'middle east', 'gulf'];
const AMERICAS_KEYWORDS = [
  '美洲',
  'americas',
  'latin america',
  'north america',
];
const EUROPE_KEYWORDS = ['欧洲', 'europe'];
const AFRICA_KEYWORDS = ['非洲', 'africa', 'sahel'];

const DEFAULT_COUNTRY_LABEL = '';
const TIE_BREAK_ORDER = new Map(
  ARCHIVE_VERTICAL_ORDER.map((vertical, index) => [vertical, index]),
);

interface ArchiveVerticalRuleSignalResult extends ArchiveRuleVerticalSignals {
  score: number;
}

export interface ArchiveRuleVerticalSignals {
  countryMatched: boolean;
  matchedCountries: string[];
  matchedStrongKeywords: string[];
  matchedWeakKeywords: string[];
  excludedKeywords: string[];
  conflictKeywords: string[];
}

export type ArchiveRuleVerticalSignalMap = Record<
  ArchiveVertical,
  ArchiveRuleVerticalSignals
>;

export interface ArchiveClassifierInput {
  title?: string | null;
  summary?: string | null;
  topics?: unknown;
  entities?: unknown;
  location?: string | null;
  source?: string | null;
}

export interface ArchiveClassificationResult {
  region: ArchiveRegion;
  vertical: ArchiveVertical;
  countryCode: string | null;
  countryLabel: string;
  entityTags: string[];
}

export interface ArchiveRuleClassificationSignals {
  region: ArchiveRegion;
  ruleVertical: ArchiveVertical;
  countryCode: string | null;
  countryLabel: string;
  entityTags: string[];
  ruleScores: ArchiveVerticalScores;
  matchedCountries: string[];
  matchedKeywords: string[];
  suppressedKeywords: string[];
  countryMatchedVerticals: ArchiveVertical[];
  verticalSignals: ArchiveRuleVerticalSignalMap;
}

const createEmptyVerticalSignals = (): ArchiveRuleVerticalSignals => ({
  countryMatched: false,
  matchedCountries: [],
  matchedStrongKeywords: [],
  matchedWeakKeywords: [],
  excludedKeywords: [],
  conflictKeywords: [],
});

const createVerticalSignalMap = (): ArchiveRuleVerticalSignalMap => ({
  [ArchiveVertical.EAST_SEA]: createEmptyVerticalSignals(),
  [ArchiveVertical.SOUTH_SEA]: createEmptyVerticalSignals(),
  [ArchiveVertical.WEST_FRONT]: createEmptyVerticalSignals(),
  [ArchiveVertical.FOREIGN_AFFAIRS]: createEmptyVerticalSignals(),
  [ArchiveVertical.DOMESTIC_AFFAIRS]: createEmptyVerticalSignals(),
});

@Injectable()
export class ArchiveClassifier {
  classify(input: ArchiveClassifierInput): ArchiveClassificationResult {
    const signals = this.classifyRuleSignals(input);
    return {
      region: signals.region,
      vertical: signals.ruleVertical,
      countryCode: signals.countryCode,
      countryLabel: signals.countryLabel,
      entityTags: signals.entityTags,
    };
  }

  classifyRuleSignals(
    input: ArchiveClassifierInput,
  ): ArchiveRuleClassificationSignals {
    const text = this.buildSearchText(input);
    const entityTags = this.collectEntityTags(input);
    const countryCodes = this.resolveCountryCodes(input, entityTags);
    const primaryCountry = countryCodes[0] ?? null;
    const countryLabel = this.resolveCountryLabel(
      primaryCountry,
      input.location,
      entityTags,
    );
    const perVertical = this.resolveVerticalRuleSignals(countryCodes, text);
    const ruleScores = createArchiveVerticalScoreMap();
    const verticalSignals = createVerticalSignalMap();
    const matchedCountries: string[] = [];
    const matchedKeywords: string[] = [];
    const suppressedKeywords: string[] = [];
    const countryMatchedVerticals: ArchiveVertical[] = [];

    for (const vertical of ARCHIVE_VERTICAL_ORDER) {
      const signal = perVertical.get(vertical);
      if (!signal) {
        continue;
      }

      ruleScores[vertical] = signal.score;
      verticalSignals[vertical] = {
        countryMatched: signal.countryMatched,
        matchedCountries: [...signal.matchedCountries],
        matchedStrongKeywords: [...signal.matchedStrongKeywords],
        matchedWeakKeywords: [...signal.matchedWeakKeywords],
        excludedKeywords: [...signal.excludedKeywords],
        conflictKeywords: [...signal.conflictKeywords],
      };

      matchedCountries.push(...signal.matchedCountries);
      matchedKeywords.push(
        ...signal.matchedStrongKeywords,
        ...signal.matchedWeakKeywords,
      );
      suppressedKeywords.push(
        ...signal.excludedKeywords,
        ...signal.conflictKeywords,
      );
      if (signal.countryMatched) {
        countryMatchedVerticals.push(vertical);
      }
    }

    return {
      region: this.resolveRegion(countryCodes, text),
      ruleVertical: this.resolveRuleVertical(ruleScores),
      countryCode: primaryCountry,
      countryLabel,
      entityTags,
      ruleScores,
      matchedCountries: Array.from(new Set(matchedCountries)),
      matchedKeywords: Array.from(new Set(matchedKeywords)),
      suppressedKeywords: Array.from(new Set(suppressedKeywords)),
      countryMatchedVerticals,
      verticalSignals,
    };
  }

  private resolveRegion(countryCodes: string[], text: string): ArchiveRegion {
    for (const code of countryCodes) {
      if (APAC_COUNTRIES.has(code)) {
        return ArchiveRegion.APAC;
      }
      if (MIDDLE_EAST_COUNTRIES.has(code)) {
        return ArchiveRegion.MIDDLE_EAST;
      }
      if (AMERICAS_COUNTRIES.has(code)) {
        return ArchiveRegion.AMERICAS;
      }
      if (EUROPE_COUNTRIES.has(code)) {
        return ArchiveRegion.EUROPE;
      }
      if (AFRICA_COUNTRIES.has(code)) {
        return ArchiveRegion.AFRICA;
      }
    }

    if (this.matchAnyKeyword(text, APAC_KEYWORDS)) {
      return ArchiveRegion.APAC;
    }
    if (this.matchAnyKeyword(text, MIDDLE_EAST_KEYWORDS)) {
      return ArchiveRegion.MIDDLE_EAST;
    }
    if (this.matchAnyKeyword(text, AMERICAS_KEYWORDS)) {
      return ArchiveRegion.AMERICAS;
    }
    if (this.matchAnyKeyword(text, EUROPE_KEYWORDS)) {
      return ArchiveRegion.EUROPE;
    }
    if (this.matchAnyKeyword(text, AFRICA_KEYWORDS)) {
      return ArchiveRegion.AFRICA;
    }
    return ArchiveRegion.OTHER;
  }

  private resolveVerticalRuleSignals(
    countryCodes: string[],
    text: string,
  ): Map<ArchiveVertical, ArchiveVerticalRuleSignalResult> {
    const results = new Map<ArchiveVertical, ArchiveVerticalRuleSignalResult>();

    for (const vertical of ARCHIVE_VERTICAL_ORDER) {
      const definition = ARCHIVE_VERTICAL_TAXONOMY[vertical];
      const countrySet = new Set(definition.countries);
      const matchedCountryCodes = countryCodes.filter((code) =>
        countrySet.has(code),
      );
      const matchedStrongKeywords = this.collectKeywordMatches(
        text,
        definition.strongKeywords,
      );
      const matchedWeakKeywords = this.collectKeywordMatches(
        text,
        definition.weakKeywords,
      );
      const excludedKeywords = this.collectKeywordMatches(
        text,
        definition.excludedKeywords,
      );
      const conflictKeywords = this.collectKeywordMatches(
        text,
        definition.conflictKeywords,
      );
      const rawScore =
        (matchedCountryCodes.length > 0 ? ARCHIVE_RULE_STRONG_SCORE : 0) +
        matchedStrongKeywords.length * ARCHIVE_RULE_STRONG_KEYWORD_INCREMENT +
        matchedWeakKeywords.length * ARCHIVE_RULE_WEAK_KEYWORD_INCREMENT -
        excludedKeywords.length * ARCHIVE_RULE_EXCLUDED_KEYWORD_PENALTY -
        conflictKeywords.length * ARCHIVE_RULE_CONFLICT_KEYWORD_PENALTY;

      results.set(vertical, {
        score: this.clamp01(rawScore),
        countryMatched: matchedCountryCodes.length > 0,
        matchedCountries: matchedCountryCodes.map(
          (code) => getCountryName(code) ?? code,
        ),
        matchedStrongKeywords,
        matchedWeakKeywords,
        excludedKeywords,
        conflictKeywords,
      });
    }

    return results;
  }

  private resolveRuleVertical(ruleScores: ArchiveVerticalScores): ArchiveVertical {
    let bestVertical = ArchiveVertical.FOREIGN_AFFAIRS;
    let bestScore = 0;

    for (const vertical of ARCHIVE_VERTICAL_ORDER) {
      const score = ruleScores[vertical] ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestVertical = vertical;
        continue;
      }
      if (
        score === bestScore &&
        (TIE_BREAK_ORDER.get(vertical) ?? Number.MAX_SAFE_INTEGER) <
          (TIE_BREAK_ORDER.get(bestVertical) ?? Number.MAX_SAFE_INTEGER)
      ) {
        bestVertical = vertical;
      }
    }

    return bestScore > 0 ? bestVertical : ArchiveVertical.FOREIGN_AFFAIRS;
  }

  private resolveCountryLabel(
    countryCode: string | null,
    location: string | null | undefined,
    entityTags: string[],
  ): string {
    if (countryCode) {
      const countryName = getCountryName(countryCode);
      if (countryName) {
        return countryName;
      }
      return countryCode;
    }

    const normalizedLocation = this.normalizeOptionalString(location);
    if (normalizedLocation) {
      return normalizedLocation;
    }

    const firstEntity = entityTags[0];
    if (firstEntity) {
      return firstEntity;
    }

    return DEFAULT_COUNTRY_LABEL;
  }

  private resolveCountryCodes(
    input: ArchiveClassifierInput,
    entityTags: string[],
  ): string[] {
    const candidates: string[] = [];
    const push = (value: string | null) => {
      const normalized = normalizeCountryCode(value);
      if (normalized) {
        candidates.push(normalized);
      }
    };

    push(extractCountryCodeFromText(input.location));
    push(extractCountryCodeFromText(input.title));
    push(extractCountryCodeFromText(input.summary));

    for (const tag of entityTags) {
      push(extractCountryCodeFromText(tag));
    }

    return Array.from(new Set(candidates));
  }

  private collectEntityTags(input: ArchiveClassifierInput): string[] {
    const tags: string[] = [];
    tags.push(...this.normalizeStringArray(input.topics));
    tags.push(...this.normalizeEntityNames(input.entities));
    return Array.from(new Set(tags)).slice(0, 12);
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((entry) => this.normalizeOptionalString(entry))
      .filter((entry): entry is string => Boolean(entry));
  }

  private normalizeEntityNames(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const names: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        const normalized = this.normalizeOptionalString(entry);
        if (normalized) {
          names.push(normalized);
        }
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }

      const name = this.normalizeOptionalString(
        (entry as { name?: unknown }).name,
      );
      if (name) {
        names.push(name);
      }
    }

    return Array.from(new Set(names));
  }

  private buildSearchText(input: ArchiveClassifierInput): string {
    return [
      this.normalizeOptionalString(input.title),
      this.normalizeOptionalString(input.summary),
      this.normalizeOptionalString(input.location),
      this.normalizeOptionalString(input.source),
      ...this.normalizeStringArray(input.topics),
      ...this.normalizeEntityNames(input.entities),
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n')
      .toLowerCase();
  }

  private collectKeywordMatches(
    text: string,
    keywords: readonly string[],
  ): string[] {
    if (!text) {
      return [];
    }

    return Array.from(
      new Set(
        keywords.filter((keyword) => {
          const normalized = keyword.trim().toLowerCase();
          return normalized.length > 0 && text.includes(normalized);
        }),
      ),
    );
  }

  private matchAnyKeyword(text: string, keywords: readonly string[]): boolean {
    return this.collectKeywordMatches(text, keywords).length > 0;
  }

  private normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    if (value <= 0) {
      return 0;
    }
    if (value >= 1) {
      return 1;
    }
    return Number(value.toFixed(6));
  }
}
