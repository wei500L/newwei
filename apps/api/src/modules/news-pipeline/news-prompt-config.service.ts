import { Injectable } from "@nestjs/common";
import { PrismaService } from "../config/prisma.service";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";

export interface NewsPromptConfig {
  version: string;
  systemPromptTemplate: string;
  userPromptTemplate: string;
}

export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = [
  "You are part of a news normalization pipeline that outputs structured JSON.",
  "Strip navigation, footers, legal boilerplate, promos, and unrelated recommendations while keeping facts, quotes, figures, and emphasis.",
  "Summaries must be 200-300 Chinese characters describing who/what/when/where/why.",
  "Return 5-8 key_points as single-sentence bullets emphasizing chronology, numbers, and impact.",
  "Entities must include type (person/org/location/product/index/policy/other) and confidence 0-1.",
  "Set removed_noise_types to the categories you deleted (e.g., footer, nav, ads).",
  "quality_score is a decimal 0-1 reflecting completeness, readability, and de-noising success.",
  "Use null for fields you cannot infer, never omit required properties.",
  "{{language_hint}}"
].join(" ");

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
  version: "news-clean-v2",
  systemPromptTemplate: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  userPromptTemplate: DEFAULT_USER_PROMPT_TEMPLATE
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
    input: NewsPromptConfig
  ): Promise<NewsPromptConfig> {
    const normalized = this.normalize(input);
    await this.prisma.systemSetting.upsert({
      where: { key: PROMPT_CONFIG_KEY },
      update: {
        value: normalized,
        updatedById: actorId,
        description: PROMPT_CONFIG_DESCRIPTION
      },
      create: {
        key: PROMPT_CONFIG_KEY,
        value: normalized,
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
    const userPromptTemplate =
      this.cleanString(config.userPromptTemplate) ??
      DEFAULT_NEWS_PROMPT_CONFIG.userPromptTemplate;

    return {
      version: version ?? DEFAULT_NEWS_PROMPT_CONFIG.version,
      systemPromptTemplate,
      userPromptTemplate
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
