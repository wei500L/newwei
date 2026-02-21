import {
  extractCountryCodeFromText,
  getCountryName,
  normalizeCountryCode,
} from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { ArchiveRegion, ArchiveVertical } from "./archive.types";

const APAC_COUNTRIES = new Set([
  "AUS",
  "BRN",
  "CHN",
  "IDN",
  "IND",
  "JPN",
  "KHM",
  "KOR",
  "LAO",
  "MMR",
  "MNG",
  "MYS",
  "NZL",
  "PAK",
  "PHL",
  "PRK",
  "SGP",
  "THA",
  "TWN",
  "VNM",
]);

const MIDDLE_EAST_COUNTRIES = new Set([
  "ARE",
  "BHR",
  "EGY",
  "IRN",
  "IRQ",
  "ISR",
  "JOR",
  "KWT",
  "LBN",
  "OMN",
  "PSE",
  "QAT",
  "SAU",
  "SYR",
  "TUR",
  "YEM",
]);

const AMERICAS_COUNTRIES = new Set([
  "ARG",
  "BOL",
  "BRA",
  "CAN",
  "CHL",
  "COL",
  "CUB",
  "ECU",
  "MEX",
  "PER",
  "USA",
  "VEN",
]);

const EUROPE_COUNTRIES = new Set([
  "AUT",
  "BEL",
  "CHE",
  "CZE",
  "DEU",
  "DNK",
  "ESP",
  "FIN",
  "FRA",
  "GBR",
  "GRC",
  "HUN",
  "IRL",
  "ITA",
  "NLD",
  "NOR",
  "POL",
  "PRT",
  "ROU",
  "RUS",
  "SWE",
  "UKR",
]);

const AFRICA_COUNTRIES = new Set([
  "AGO",
  "BWA",
  "CMR",
  "COD",
  "DZA",
  "ETH",
  "GHA",
  "KEN",
  "LBY",
  "MAR",
  "NGA",
  "SDN",
  "SEN",
  "SOM",
  "TUN",
  "UGA",
  "ZAF",
]);

const EAST_SEA_COUNTRIES = new Set(["JPN", "KOR", "PRK", "TWN"]);
const SOUTH_SEA_COUNTRIES = new Set([
  "BRN",
  "IDN",
  "KHM",
  "LAO",
  "MYS",
  "MMR",
  "PHL",
  "SGP",
  "THA",
  "VNM",
]);
const WEST_FRONT_COUNTRIES = new Set([
  "AFG",
  "IND",
  "IRN",
  "KAZ",
  "KGZ",
  "PAK",
  "TJK",
  "TKM",
  "UZB",
]);

const EAST_SEA_KEYWORDS = [
  "东海",
  "朝鲜半岛",
  "钓鱼岛",
  "日本海",
  "防卫白皮书",
  "korean peninsula",
  "east china sea",
  "japan defense",
  "ww",
];

const SOUTH_SEA_KEYWORDS = [
  "南海",
  "黄岩岛",
  "仁爱礁",
  "海警",
  "南沙",
  "西沙",
  "马六甲",
  "south china sea",
  "spratly",
  "scarborough",
];

const WEST_FRONT_KEYWORDS = [
  "西面",
  "阿富汗",
  "中亚",
  "克什米尔",
  "边境冲突",
  "afghanistan",
  "central asia",
  "kashmir",
  "india pakistan",
  "tajik",
  "uzbek",
];

const FOREIGN_AFFAIRS_KEYWORDS = [
  "外交",
  "制裁",
  "反制",
  "关税",
  "贸易争端",
  "多边会谈",
  "diplomacy",
  "sanction",
  "countermeasure",
  "trade dispute",
  "embargo",
  "summit",
];

const DOMESTIC_AFFAIRS_KEYWORDS = [
  "内务",
  "国内",
  "政策调整",
  "五年规划",
  "农业",
  "能源战略",
  "基建",
  "domestic policy",
  "internal policy",
  "energy strategy",
  "agriculture plan",
  "infrastructure",
];

const APAC_KEYWORDS = [
  "亚太",
  "asia pacific",
  "indo-pacific",
  "东亚",
  "东南亚",
  "南亚",
];
const MIDDLE_EAST_KEYWORDS = ["中东", "middle east", "gulf"];
const AMERICAS_KEYWORDS = [
  "美洲",
  "americas",
  "latin america",
  "north america",
];
const EUROPE_KEYWORDS = ["欧洲", "europe", "eu"];
const AFRICA_KEYWORDS = ["非洲", "africa", "sahel"];

// Keep fallback locale-neutral so frontend i18n can render per current language.
const DEFAULT_COUNTRY_LABEL = "";

export interface ArchiveClassifierInput {
  title?: string | null;
  summary?: string | null;
  topics?: unknown;
  entities?: unknown;
  location?: string | null;
}

export interface ArchiveClassificationResult {
  region: ArchiveRegion;
  vertical: ArchiveVertical;
  countryCode: string | null;
  countryLabel: string;
  entityTags: string[];
}

@Injectable()
export class ArchiveClassifier {
  classify(input: ArchiveClassifierInput): ArchiveClassificationResult {
    const text = this.buildSearchText(input);
    const entityTags = this.collectEntityTags(input);
    const countryCodes = this.resolveCountryCodes(input, entityTags);
    const primaryCountry = countryCodes[0] ?? null;
    const countryLabel = this.resolveCountryLabel(
      primaryCountry,
      input.location,
      entityTags,
    );

    return {
      region: this.resolveRegion(countryCodes, text),
      vertical: this.resolveVertical(countryCodes, text),
      countryCode: primaryCountry,
      countryLabel,
      entityTags,
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

  private resolveVertical(
    countryCodes: string[],
    text: string,
  ): ArchiveVertical {
    if (
      countryCodes.some((code) => EAST_SEA_COUNTRIES.has(code)) ||
      this.matchAnyKeyword(text, EAST_SEA_KEYWORDS)
    ) {
      return ArchiveVertical.EAST_SEA;
    }
    if (
      countryCodes.some((code) => SOUTH_SEA_COUNTRIES.has(code)) ||
      this.matchAnyKeyword(text, SOUTH_SEA_KEYWORDS)
    ) {
      return ArchiveVertical.SOUTH_SEA;
    }
    if (
      countryCodes.some((code) => WEST_FRONT_COUNTRIES.has(code)) ||
      this.matchAnyKeyword(text, WEST_FRONT_KEYWORDS)
    ) {
      return ArchiveVertical.WEST_FRONT;
    }
    if (this.matchAnyKeyword(text, FOREIGN_AFFAIRS_KEYWORDS)) {
      return ArchiveVertical.FOREIGN_AFFAIRS;
    }
    if (this.matchAnyKeyword(text, DOMESTIC_AFFAIRS_KEYWORDS)) {
      return ArchiveVertical.DOMESTIC_AFFAIRS;
    }
    return ArchiveVertical.FOREIGN_AFFAIRS;
  }

  private resolveCountryLabel(
    countryCode: string | null,
    location: string | null | undefined,
    entityTags: string[],
  ) {
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
  ) {
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
      if (typeof entry === "string") {
        const normalized = this.normalizeOptionalString(entry);
        if (normalized) {
          names.push(normalized);
        }
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }

      const name = this.normalizeOptionalString(
        (entry as { name?: unknown }).name,
      );
      if (name) {
        names.push(name);
      }
    }
    return names;
  }

  private buildSearchText(input: ArchiveClassifierInput) {
    return [
      this.normalizeOptionalString(input.title),
      this.normalizeOptionalString(input.summary),
      this.normalizeOptionalString(input.location),
      ...this.normalizeStringArray(input.topics),
      ...this.normalizeEntityNames(input.entities),
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n")
      .toLowerCase();
  }

  private matchAnyKeyword(text: string, keywords: readonly string[]) {
    if (!text) {
      return false;
    }
    return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
  }

  private normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}
