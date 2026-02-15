import { gql } from "@apollo/client";

export type RssTranslationProvider = "deeplx" | "llm";
export type RssTranslationField =
  | "title"
  | "summary"
  | "key_points"
  | "cleaned_markdown";

export interface RssTranslationProviderStatus {
  provider: RssTranslationProvider;
  available: boolean;
  message?: string | null;
  targetLanguageSupported: boolean;
}

export interface RssTranslationStatusQuery {
  rssTranslationStatus: RssTranslationProviderStatus[];
}

export interface RssTranslationStatusQueryVariables {
  targetLanguage?: string;
}

export interface RssItemTranslation {
  itemId: string;
  title?: string | null;
  summary?: string | null;
  keyPoints?: string[] | null;
  cleanedMarkdown?: string | null;
}

export interface TranslateRssItemsMutation {
  translateRssItems: {
    provider: RssTranslationProvider;
    targetLanguage: string;
    translations: RssItemTranslation[];
  };
}

export interface TranslateRssItemsMutationVariables {
  input: {
    itemIds: string[];
    provider: RssTranslationProvider;
    fields?: RssTranslationField[];
    targetLanguage: string;
  };
}

export const RSS_TRANSLATION_STATUS_QUERY = gql`
  query RssTranslationStatus($targetLanguage: String) {
    rssTranslationStatus(targetLanguage: $targetLanguage) {
      provider
      available
      message
      targetLanguageSupported
    }
  }
`;

export const TRANSLATE_RSS_ITEMS_MUTATION = gql`
  mutation TranslateRssItems($input: TranslateRssItemsInput!) {
    translateRssItems(input: $input) {
      provider
      targetLanguage
      translations {
        itemId
        title
        summary
        keyPoints
        cleanedMarkdown
      }
    }
  }
`;

export const RSS_TRANSLATION_TARGET_LANGUAGE_OPTIONS: Array<{
  value: string;
  label: string;
}> = [
  { value: "zh-CN", label: "中文（简体）" },
  { value: "en", label: "English" }
];

export function isChineseTargetLanguage(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh-");
}
