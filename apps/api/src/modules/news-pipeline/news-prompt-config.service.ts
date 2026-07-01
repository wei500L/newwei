import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PrismaService } from "../config/prisma.service";

export interface NewsPromptConfig {
  version: string;
  systemPromptTemplate: string;
  denoisePromptTemplate: string;
  userPromptTemplate: string;
  entitySystemPromptTemplate: string;
  entityUserPromptTemplate: string;
  sentimentSystemPromptTemplate: string;
  sentimentUserPromptTemplate: string;
  kgSystemPromptTemplate: string;
  kgUserPromptTemplate: string;
}

export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = [
  "You are part of a news normalization pipeline that outputs structured JSON.",
  "Strip navigation, footers, legal boilerplate, promos, and unrelated recommendations while keeping facts, quotes, figures, and emphasis.",
  "Summaries must be 200-300 Chinese characters describing who/what/when/where/why.",
  "Return 5-8 key_points as single-sentence bullets emphasizing chronology, numbers, and impact.",
  "Entities must include type (person/company/industry/organization/location/product/index/policy/commodity/other) and confidence 0-1.",
  "Additionally extract kg_relations (max 20) for a finance knowledge graph when applicable.",
  "Each kg_relations item must include subject{name,type}, predicate, object{name,type}, confidence 0-1, optional properties object, and optional evidence quote.",
  "Allowed predicate values: belongs_to_industry, supplies, customer_of, competes_with, holds_position, affects_industry, affects_company, upstream_of, downstream_of, has_ticker.",
  "Always populate removed_noise_types with every noise category you remove, including garbled_text for encoding noise.",
  "quality_score is a decimal 0-1 reflecting completeness, readability, and de-noising success.",
  "sentiment_label must be one of positive/neutral/negative reflecting the overall tone; use neutral when uncertain.",
  "content_type must be one of news_fact/opinion/analysis/mixed. news_fact = event reporting with verifiable facts; opinion = viewpoint-heavy commentary; analysis = interpretive explanation/forecast; mixed = substantial overlap.",
  "Use null for fields you cannot infer, never omit required properties.",
  "{{language_hint}}"
].join(" ");

export const DEFAULT_DENOISE_PROMPT_TEMPLATE = [
  "Denoise step (do this before extracting fields):",
  "Keep the article headline, lead, body text, and relevant quotes/figures.",
  "Remove site chrome and boilerplate such as navigation/menus, headers/footers, sidebars, tag clouds, related links/recommendations, comments, cookie/privacy/legal notices, author bios, social/share widgets, subscription/paywall prompts, ads/sponsored/promos, tracking/scripts/styles, and unrelated content.",
  "Drop garbled or non-language text (mojibake, replacement characters, repeated symbols).",
  "Record every removed category in removed_noise_types using snake_case from: {{noise_type_list}}. If nothing removed, return []."
].join("\n");

export const DEFAULT_USER_PROMPT_TEMPLATE = [
  "URL: {{url}}",
  "Cache hit: {{cache_hit}}",
  "{{metadata_section}}",
  "{{keywords_section}}",
  "{{summary_hints_section}}",
  "",
  "Clean this markdown while keeping only the newsworthy sections:",
  "{{markdown}}"
].join("\n");

export const DEFAULT_NEWS_PROMPT_CONFIG: NewsPromptConfig = {
  version: "news-clean-v4",
  systemPromptTemplate: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  denoisePromptTemplate: DEFAULT_DENOISE_PROMPT_TEMPLATE,
  userPromptTemplate: DEFAULT_USER_PROMPT_TEMPLATE,
  entitySystemPromptTemplate: [
    "You extract named entities from cleaned news content into strict JSON.",
    "Return 0-20 entities with fields: name, type, confidence.",
    "Allowed entity types: person/company/industry/organization/location/product/index/policy/commodity/other.",
    "Only include entities explicitly supported by the article.",
  ].join(" "),
  entityUserPromptTemplate: [
    "Extract entities from this cleaned article.",
    "Title: {{title}}",
    "Summary: {{summary}}",
    "Language: {{language}}",
    "",
    "{{markdown}}",
  ].join("\n"),
  sentimentSystemPromptTemplate: [
    "You assign overall article sentiment into strict JSON.",
    "Return sentiment_label as one of positive, neutral, or negative.",
    "Use neutral when the tone is mixed, descriptive, or uncertain.",
  ].join(" "),
  sentimentUserPromptTemplate: [
    "Classify the overall sentiment of this cleaned article.",
    "Title: {{title}}",
    "Summary: {{summary}}",
    "Language: {{language}}",
    "",
    "{{markdown}}",
  ].join("\n"),
  kgSystemPromptTemplate: [
    "You extract finance-oriented knowledge graph relations into strict JSON.",
    "Return up to 20 kg_relations with subject{name,type}, predicate, object{name,type}, confidence 0-1, optional properties, optional evidence.",
    "Allowed predicate values: belongs_to_industry, supplies, customer_of, competes_with, holds_position, affects_industry, affects_company, upstream_of, downstream_of, has_ticker.",
    "Only include relations directly supported by the text.",
  ].join(" "),
  kgUserPromptTemplate: [
    "Extract knowledge graph relations from this cleaned article.",
    "Title: {{title}}",
    "Summary: {{summary}}",
    "Language: {{language}}",
    "",
    "{{markdown}}",
  ].join("\n"),
};

const PROMPT_CONFIG_KEY = "news_pipeline_prompt_config";
const PROMPT_CONFIG_DESCRIPTION =
  "Configurable prompt templates for the news cleaning pipeline.";

@Injectable()
export class NewsPromptConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getConfig(): Promise<NewsPromptConfig> {
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: PROMPT_CONFIG_KEY }
    });
    const raw = (record?.value as Partial<NewsPromptConfig> | undefined) ?? {};
    return this.normalize(raw);
  }

  async updateConfig(
    orgId: string,
    actorId: string,
    input: Partial<NewsPromptConfig>
  ): Promise<NewsPromptConfig> {
    const normalized = this.normalize(input);
    await this.prisma.systemSetting.upsert({
      where: { key: PROMPT_CONFIG_KEY },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: PROMPT_CONFIG_DESCRIPTION
      },
      create: {
        key: PROMPT_CONFIG_KEY,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: PROMPT_CONFIG_DESCRIPTION
      }
    });
    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "news_pipeline_prompt",
          action: "update",
          metadata: {
            version: normalized.version
          }
        }
      },
      { orgId, actorId, resource: "news_pipeline_prompt", action: "update" }
    );
    return normalized;
  }

  private normalize(config: Partial<NewsPromptConfig>): NewsPromptConfig {
    const version = this.cleanString(config.version);
    const systemPromptTemplate =
      this.cleanString(config.systemPromptTemplate) ??
      DEFAULT_NEWS_PROMPT_CONFIG.systemPromptTemplate;
    const denoisePromptTemplate =
      this.cleanString(config.denoisePromptTemplate) ??
      DEFAULT_NEWS_PROMPT_CONFIG.denoisePromptTemplate;
    const userPromptTemplate =
      this.cleanString(config.userPromptTemplate) ??
      DEFAULT_NEWS_PROMPT_CONFIG.userPromptTemplate;
    const entitySystemPromptTemplate =
      this.cleanString(config.entitySystemPromptTemplate) ??
      DEFAULT_NEWS_PROMPT_CONFIG.entitySystemPromptTemplate;
    const entityUserPromptTemplate =
      this.cleanString(config.entityUserPromptTemplate) ??
      DEFAULT_NEWS_PROMPT_CONFIG.entityUserPromptTemplate;
    const sentimentSystemPromptTemplate =
      this.cleanString(config.sentimentSystemPromptTemplate) ??
      DEFAULT_NEWS_PROMPT_CONFIG.sentimentSystemPromptTemplate;
    const sentimentUserPromptTemplate =
      this.cleanString(config.sentimentUserPromptTemplate) ??
      DEFAULT_NEWS_PROMPT_CONFIG.sentimentUserPromptTemplate;
    const kgSystemPromptTemplate =
      this.cleanString(config.kgSystemPromptTemplate) ??
      DEFAULT_NEWS_PROMPT_CONFIG.kgSystemPromptTemplate;
    const kgUserPromptTemplate =
      this.cleanString(config.kgUserPromptTemplate) ??
      DEFAULT_NEWS_PROMPT_CONFIG.kgUserPromptTemplate;

    return {
      version: version ?? DEFAULT_NEWS_PROMPT_CONFIG.version,
      systemPromptTemplate,
      denoisePromptTemplate,
      userPromptTemplate,
      entitySystemPromptTemplate,
      entityUserPromptTemplate,
      sentimentSystemPromptTemplate,
      sentimentUserPromptTemplate,
      kgSystemPromptTemplate,
      kgUserPromptTemplate,
    };
  }

  private cleanString(value?: string) {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed;
  }
}
