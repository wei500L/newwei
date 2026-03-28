export interface SituationNewsItem {
  title: string;
  titleZh?: string;
  link: string;
  source: string;
  timestamp: number;
  origin?: "items" | "gdelt";
  itemMetaId?: string;
  summary?: string;
  keyPoints?: string[];
  topics?: string[];
}
