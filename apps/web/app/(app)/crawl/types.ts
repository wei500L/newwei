import type { Dayjs } from "dayjs";
import type {
  BrowserCookieFormValue,
  BrowserHeaderFormValue,
  CleanMarkdownFormValue,
  CrawlMultiUrlStrategyFormValue,
  CrawlOptionsFormValues,
  GeolocationFormValue,
  LinkPreviewFormValue,
  MarkdownFilterFormValue,
  MarkdownOptionsFormValue,
  MarkdownStrategyFormValue,
  TableExtractionFormValue,
  UserAgentGeneratorFormValue,
} from "@modular/utils";

export interface CreateCrawlTaskFormValues extends CrawlOptionsFormValues {
  url: string;
  displayName?: string;
  keywords?: string[];
  timeRange?: Dayjs[];
  concurrency?: number;
  markdownOptions?: MarkdownOptionsFormValue;
  markdownFilter?: MarkdownFilterFormValue;
  markdownStrategy?: MarkdownStrategyFormValue;
  cleanMarkdown?: CleanMarkdownFormValue;
  tableExtraction?: TableExtractionFormValue;
  linkPreview?: LinkPreviewFormValue;
  multiUrlConfigs?: CrawlMultiUrlStrategyFormValue[];
  browserHeaders?: BrowserHeaderFormValue[];
  browserCookies?: BrowserCookieFormValue[];
  userAgentGenerator?: UserAgentGeneratorFormValue;
  geolocation?: GeolocationFormValue;
}

export interface MetadataFormValues {
  source: "sitemap" | "urls";
  domain?: string;
  pattern?: string;
  maxUrls?: number;
  query?: string;
  scoreThreshold?: number;
  urls?: string;
}
