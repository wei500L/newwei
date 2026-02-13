export const CRAWL_IMAGE_STORAGE_PROVIDERS = ["mysql", "s3"] as const;

export type CrawlImageStorageProvider = (typeof CRAWL_IMAGE_STORAGE_PROVIDERS)[number];

export const DEFAULT_CRAWL_IMAGE_STORAGE_PROVIDER: CrawlImageStorageProvider = "mysql";
