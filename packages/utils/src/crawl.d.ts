export interface CrawlProxyConfigFormValue {
    server?: string;
    username?: string;
    password?: string;
}
export interface CrawlUrlMatcherFormValue {
    matchMode?: string;
    patterns?: string[];
}
export interface CrawlStrategyOverridesFormValue {
    cacheMode?: string;
    scanFullPage?: boolean;
    adjustViewportToContent?: boolean;
    scrollDelayMs?: number;
    onlyMainContent?: boolean;
    extractLinks?: boolean;
    simulateUser?: boolean;
    overrideNavigator?: boolean;
    jsCode?: string[];
    jsOnly?: boolean;
    waitForSelector?: string;
    waitForScript?: string;
    waitForTimeoutMs?: number;
}
export interface CrawlMultiUrlStrategyFormValue {
    name?: string;
    matcher?: CrawlUrlMatcherFormValue;
    urls?: string[];
    options?: CrawlStrategyOverridesFormValue;
}
export interface MarkdownOptionsFormValue {
    contentSource?: string;
    ignoreLinks?: boolean;
    escapeHtml?: boolean;
    bodyWidth?: number;
}
export interface MarkdownFilterFormValue {
    type?: string;
    threshold?: number;
    thresholdType?: "fixed" | "dynamic";
    minWordThreshold?: number;
}
export interface MarkdownStrategyFormValue {
    type?: string;
    params?: string;
}
export interface TableExtractionFormValue {
    type?: string;
    params?: string;
    minRows?: number;
    minCols?: number;
}
export interface CleanMarkdownFormValue {
    cssSelector?: string;
    targetElements?: string[];
    excludedTags?: string[];
    removeOverlayElements?: boolean;
    wordCountThreshold?: number;
}
export interface LinkPreviewFormValue {
    includeInternal?: boolean;
    includeExternal?: boolean;
    includeSocial?: boolean;
    maxLinks?: number;
    concurrency?: number;
    timeoutSeconds?: number;
    query?: string;
    scoreThreshold?: number;
    verbose?: boolean;
    includePatterns?: string[];
    excludePatterns?: string[];
}
export interface BrowserHeaderFormValue {
    name?: string;
    value?: string;
}
export interface BrowserCookieFormValue {
    name?: string;
    value?: string;
    domain?: string;
    path?: string;
}
export interface UserAgentGeneratorFormValue {
    platform?: string;
    browser?: string;
    deviceType?: string;
    locale?: string;
}
export interface GeolocationFormValue {
    latitude?: number;
    longitude?: number;
    accuracy?: number;
}
export interface CrawlOptionsFormValues {
    includeImages?: boolean;
    storeMedia?: boolean;
    onlyMainContent?: boolean;
    extractLinks?: boolean;
    excludeExternalImages?: boolean;
    scanFullPage?: boolean;
    adjustViewportToContent?: boolean;
    scrollDelayMs?: number;
    enableUndetectedBrowser?: boolean;
    enableStealthMode?: boolean;
    useManagedBrowser?: boolean;
    userDataDir?: string;
    simulateUser?: boolean;
    overrideNavigator?: boolean;
    jsCode?: string[];
    jsOnly?: boolean;
    waitForSelector?: string;
    waitForScript?: string;
    waitForTimeoutMs?: number;
    waitForImages?: boolean;
    sessionId?: string;
    storageState?: string;
    proxyUrl?: string;
    proxyConfig?: CrawlProxyConfigFormValue;
    additionalUrls?: string[];
    multiUrlConfigs?: CrawlMultiUrlStrategyFormValue[];
    markdownOptions?: MarkdownOptionsFormValue;
    markdownFilter?: MarkdownFilterFormValue;
    markdownStrategy?: MarkdownStrategyFormValue;
    tableScoreThreshold?: number;
    tableExtraction?: TableExtractionFormValue;
    cleanMarkdown?: CleanMarkdownFormValue;
    scoreLinks?: boolean;
    linkPreview?: LinkPreviewFormValue;
    browserHeaders?: BrowserHeaderFormValue[];
    browserCookies?: BrowserCookieFormValue[];
    userAgent?: string;
    userAgentMode?: "random" | string;
    userAgentGenerator?: UserAgentGeneratorFormValue;
    locale?: string;
    timezoneId?: string;
    geolocation?: GeolocationFormValue;
}
export interface CrawlStrategyOverridesValue {
    cacheMode?: string;
    scanFullPage?: boolean;
    adjustViewportToContent?: boolean;
    scrollDelayMs?: number;
    onlyMainContent?: boolean;
    extractLinks?: boolean;
    simulateUser?: boolean;
    overrideNavigator?: boolean;
    jsCode?: string[];
    jsOnly?: boolean;
    waitForSelector?: string;
    waitForScript?: string;
    waitForTimeoutMs?: number;
}
export interface CrawlMultiUrlStrategyValue {
    name?: string;
    matcher?: {
        matchMode?: string;
        patterns: string[];
    };
    urls?: string[];
    options?: CrawlStrategyOverridesValue;
}
export interface CrawlMarkdownStrategyValue {
    type: string;
    params?: Record<string, unknown>;
}
export interface CrawlTableExtractionValue {
    type: string;
    params?: Record<string, unknown>;
}
export interface CrawlCleanMarkdownValue {
    cssSelector?: string;
    targetElements?: string[];
    excludedTags?: string[];
    removeOverlayElements?: boolean;
    wordCountThreshold?: number;
}
export interface CrawlLinkPreviewValue {
    includeInternal?: boolean;
    includeExternal?: boolean;
    includeSocial?: boolean;
    maxLinks?: number;
    concurrency?: number;
    timeoutSeconds?: number;
    query?: string;
    scoreThreshold?: number;
    verbose?: boolean;
    includePatterns?: string[];
    excludePatterns?: string[];
}
export interface CrawlGeolocationValue {
    latitude: number;
    longitude: number;
    accuracy?: number;
}
export interface CrawlOptionsValue {
    includeImages?: boolean;
    storeMedia?: boolean;
    onlyMainContent?: boolean;
    extractLinks?: boolean;
    excludeExternalImages?: boolean;
    scanFullPage?: boolean;
    adjustViewportToContent?: boolean;
    scrollDelayMs?: number;
    enableUndetectedBrowser?: boolean;
    enableStealthMode?: boolean;
    useManagedBrowser?: boolean;
    userDataDir?: string;
    simulateUser?: boolean;
    overrideNavigator?: boolean;
    jsCode?: string[];
    jsOnly?: boolean;
    waitForSelector?: string;
    waitForScript?: string;
    waitForTimeoutMs?: number;
    waitForImages?: boolean;
    sessionId?: string;
    storageState?: string;
    proxyUrl?: string;
    proxyConfig?: {
        server: string;
        username?: string;
        password?: string;
    };
    additionalUrls?: string[];
    multiUrlConfigs?: CrawlMultiUrlStrategyValue[];
    markdownOptions?: MarkdownOptionsFormValue;
    markdownFilter?: MarkdownFilterFormValue;
    markdownStrategy?: CrawlMarkdownStrategyValue;
    tableScoreThreshold?: number;
    tableExtraction?: CrawlTableExtractionValue;
    cleanMarkdown?: CrawlCleanMarkdownValue;
    scoreLinks?: boolean;
    linkPreview?: CrawlLinkPreviewValue;
    browserHeaders?: {
        name: string;
        value: string;
    }[];
    browserCookies?: {
        name: string;
        value: string;
        domain: string;
        path?: string;
    }[];
    userAgent?: string;
    userAgentMode?: "random";
    userAgentGenerator?: UserAgentGeneratorFormValue;
    locale?: string;
    timezoneId?: string;
    geolocation?: CrawlGeolocationValue;
}
export declare const sanitizeStringList: (list?: string[]) => string[] | undefined;
export declare const sanitizeJsCodeList: (list?: string[]) => string[] | undefined;
export declare const sanitizeStrategyOptions: (options?: CrawlStrategyOverridesFormValue) => CrawlStrategyOverridesValue | undefined;
export declare const sanitizeMultiUrlConfigs: (configs?: CrawlMultiUrlStrategyFormValue[]) => CrawlMultiUrlStrategyValue[] | undefined;
export declare const sanitizeMarkdownOptions: (options?: MarkdownOptionsFormValue) => Record<string, unknown> | undefined;
export declare const sanitizeMarkdownFilter: (filter?: MarkdownFilterFormValue) => Record<string, unknown> | undefined;
export declare const sanitizeMarkdownStrategy: (strategy?: MarkdownStrategyFormValue) => CrawlMarkdownStrategyValue | undefined;
export declare const sanitizeTableExtraction: (strategy?: TableExtractionFormValue) => CrawlTableExtractionValue | undefined;
export declare const sanitizeCleanMarkdown: (options?: CleanMarkdownFormValue) => CrawlCleanMarkdownValue | undefined;
export declare const sanitizeLinkPreview: (preview?: LinkPreviewFormValue) => CrawlLinkPreviewValue | undefined;
export declare const sanitizeBrowserHeaders: (headers?: BrowserHeaderFormValue[]) => {
    name: string;
    value: string;
}[] | undefined;
export declare const sanitizeBrowserCookies: (cookies?: BrowserCookieFormValue[]) => {
    name: string;
    value: string;
    domain: string;
    path: string | undefined;
}[] | undefined;
export declare const sanitizeUserAgentGenerator: (generator?: UserAgentGeneratorFormValue) => UserAgentGeneratorFormValue | undefined;
export declare const sanitizeGeolocation: (geo?: GeolocationFormValue) => CrawlGeolocationValue | undefined;
export declare const sanitizeCrawlOptions: (values: CrawlOptionsFormValues) => CrawlOptionsValue;
//# sourceMappingURL=crawl.d.ts.map