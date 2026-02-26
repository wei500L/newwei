export const CRAWL_QUEUE_NAME = "crawl4ai";
export const CRAWL_QUEUE_HOT_NAME = "crawl4ai-hot";
export const CRAWL_QUEUE_NORMAL_NAME = "crawl4ai-normal";
export const CRAWL_QUEUE_MODE = "dual";
export const CRAWL_HOT_PRIORITY_THRESHOLD = 50;

export const CRAWL_QUEUE_LEGACY = Symbol("CRAWL_QUEUE_LEGACY");
export const CRAWL_QUEUE_EVENTS_LEGACY = Symbol("CRAWL_QUEUE_EVENTS_LEGACY");
export const CRAWL_QUEUE_HOT = Symbol("CRAWL_QUEUE_HOT");
export const CRAWL_QUEUE_NORMAL = Symbol("CRAWL_QUEUE_NORMAL");
export const CRAWL_QUEUE_EVENTS_HOT = Symbol("CRAWL_QUEUE_EVENTS_HOT");
export const CRAWL_QUEUE_EVENTS_NORMAL = Symbol("CRAWL_QUEUE_EVENTS_NORMAL");

// Backward-compatible aliases.
export const CRAWL_QUEUE = CRAWL_QUEUE_NORMAL;
export const CRAWL_QUEUE_EVENTS = CRAWL_QUEUE_EVENTS_NORMAL;
