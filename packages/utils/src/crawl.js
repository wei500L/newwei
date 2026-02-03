"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeCrawlOptions = exports.sanitizeGeolocation = exports.sanitizeUserAgentGenerator = exports.sanitizeBrowserCookies = exports.sanitizeBrowserHeaders = exports.sanitizeLinkPreview = exports.sanitizeCleanMarkdown = exports.sanitizeTableExtraction = exports.sanitizeMarkdownStrategy = exports.sanitizeMarkdownFilter = exports.sanitizeMarkdownOptions = exports.sanitizeMultiUrlConfigs = exports.sanitizeStrategyOptions = exports.sanitizeJsCodeList = exports.sanitizeStringList = void 0;
const sanitizeStringList = (list) => list
    ?.map((value) => value?.trim())
    .filter((value) => Boolean(value && value.length > 0));
exports.sanitizeStringList = sanitizeStringList;
const sanitizeJsCodeList = (list) => {
    const sanitized = (0, exports.sanitizeStringList)(list);
    return sanitized && sanitized.length ? sanitized.slice(0, 10) : undefined;
};
exports.sanitizeJsCodeList = sanitizeJsCodeList;
const sanitizeStrategyOptions = (options) => {
    if (!options) {
        return undefined;
    }
    const cleaned = {};
    if (options.cacheMode) {
        cleaned.cacheMode = options.cacheMode;
    }
    if (typeof options.scanFullPage === "boolean") {
        cleaned.scanFullPage = options.scanFullPage;
    }
    if (typeof options.adjustViewportToContent === "boolean") {
        cleaned.adjustViewportToContent = options.adjustViewportToContent;
    }
    if (typeof options.scrollDelayMs === "number") {
        cleaned.scrollDelayMs = options.scrollDelayMs;
    }
    if (typeof options.onlyMainContent === "boolean") {
        cleaned.onlyMainContent = options.onlyMainContent;
    }
    if (typeof options.extractLinks === "boolean") {
        cleaned.extractLinks = options.extractLinks;
    }
    if (typeof options.simulateUser === "boolean") {
        cleaned.simulateUser = options.simulateUser;
    }
    if (typeof options.overrideNavigator === "boolean") {
        cleaned.overrideNavigator = options.overrideNavigator;
    }
    const jsCode = (0, exports.sanitizeJsCodeList)(options.jsCode);
    if (jsCode) {
        cleaned.jsCode = jsCode;
    }
    if (typeof options.jsOnly === "boolean") {
        cleaned.jsOnly = options.jsOnly;
    }
    const waitForSelector = options.waitForSelector?.trim();
    if (waitForSelector) {
        cleaned.waitForSelector = waitForSelector;
    }
    const waitForScript = options.waitForScript?.trim();
    if (waitForScript) {
        cleaned.waitForScript = waitForScript;
    }
    if (typeof options.waitForTimeoutMs === "number") {
        cleaned.waitForTimeoutMs = options.waitForTimeoutMs;
    }
    return Object.keys(cleaned).length ? cleaned : undefined;
};
exports.sanitizeStrategyOptions = sanitizeStrategyOptions;
const sanitizeMultiUrlConfigs = (configs) => {
    if (!configs) {
        return undefined;
    }
    const normalized = configs
        .map((config) => {
        const name = config.name?.trim();
        const matcherPatterns = (0, exports.sanitizeStringList)(config.matcher?.patterns);
        const matcher = matcherPatterns && matcherPatterns.length
            ? {
                matchMode: config.matcher?.matchMode || undefined,
                patterns: matcherPatterns,
            }
            : undefined;
        const urls = (0, exports.sanitizeStringList)(config.urls);
        const options = (0, exports.sanitizeStrategyOptions)(config.options);
        if (!matcher && (!urls || urls.length === 0)) {
            return null;
        }
        return {
            name: name || undefined,
            matcher,
            urls: urls && urls.length ? urls : undefined,
            options,
        };
    })
        .filter((entry) => Boolean(entry));
    return normalized.length ? normalized : undefined;
};
exports.sanitizeMultiUrlConfigs = sanitizeMultiUrlConfigs;
const sanitizeMarkdownOptions = (options) => {
    if (!options) {
        return undefined;
    }
    const payload = {};
    if (options.contentSource) {
        payload.contentSource = options.contentSource;
    }
    if (typeof options.ignoreLinks === "boolean") {
        payload.ignoreLinks = options.ignoreLinks;
    }
    if (typeof options.escapeHtml === "boolean") {
        payload.escapeHtml = options.escapeHtml;
    }
    if (typeof options.bodyWidth === "number") {
        payload.bodyWidth = options.bodyWidth;
    }
    return Object.keys(payload).length ? payload : undefined;
};
exports.sanitizeMarkdownOptions = sanitizeMarkdownOptions;
const sanitizeMarkdownFilter = (filter) => {
    if (!filter?.type) {
        return undefined;
    }
    const payload = { type: filter.type };
    if (typeof filter.threshold === "number") {
        payload.threshold = filter.threshold;
    }
    if (filter.thresholdType === "fixed" || filter.thresholdType === "dynamic") {
        payload.thresholdType = filter.thresholdType;
    }
    if (typeof filter.minWordThreshold === "number") {
        payload.minWordThreshold = filter.minWordThreshold;
    }
    return payload;
};
exports.sanitizeMarkdownFilter = sanitizeMarkdownFilter;
const sanitizeMarkdownStrategy = (strategy) => {
    if (!strategy?.type) {
        return undefined;
    }
    const trimmedType = strategy.type.trim();
    if (!trimmedType) {
        return undefined;
    }
    let params;
    if (strategy.params && strategy.params.trim().length) {
        try {
            const parsed = JSON.parse(strategy.params);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("Custom Markdown strategy params must be a JSON object");
            }
            params = parsed;
        }
        catch (error) {
            throw new Error(error.message ??
                "Custom Markdown strategy params must be valid JSON");
        }
    }
    const normalizedType = trimmedType.slice(0, 128);
    return params ? { type: normalizedType, params } : { type: normalizedType };
};
exports.sanitizeMarkdownStrategy = sanitizeMarkdownStrategy;
const sanitizeTableExtraction = (strategy) => {
    const hasCustomParams = (strategy?.params && strategy.params.trim().length > 0) ||
        typeof strategy?.minRows === "number" ||
        typeof strategy?.minCols === "number";
    if (!strategy?.type && !hasCustomParams) {
        return undefined;
    }
    const rawType = strategy?.type?.trim() ?? (hasCustomParams ? "DefaultTableExtraction" : "");
    if (!rawType) {
        return undefined;
    }
    const trimmedType = rawType;
    let params;
    if (strategy.params && strategy.params.trim().length) {
        try {
            const parsed = JSON.parse(strategy.params);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("Table extraction params must be a JSON object");
            }
            params = parsed;
        }
        catch (error) {
            throw new Error(error.message ??
                "Table extraction params must be valid JSON");
        }
    }
    const normalizedParams = params ? { ...params } : {};
    if (typeof strategy.minRows === "number") {
        normalizedParams.min_rows = strategy.minRows;
    }
    if (typeof strategy.minCols === "number") {
        normalizedParams.min_cols = strategy.minCols;
    }
    const normalizedType = trimmedType.slice(0, 128);
    return Object.keys(normalizedParams).length
        ? { type: normalizedType, params: normalizedParams }
        : { type: normalizedType };
};
exports.sanitizeTableExtraction = sanitizeTableExtraction;
const sanitizeCleanMarkdown = (options) => {
    if (!options) {
        return undefined;
    }
    const payload = {};
    if (typeof options.cssSelector === "string" &&
        options.cssSelector.trim().length) {
        payload.cssSelector = options.cssSelector.trim();
    }
    const targetElements = (0, exports.sanitizeStringList)(options.targetElements)?.slice(0, 10);
    if (targetElements?.length) {
        payload.targetElements = targetElements;
    }
    const excludedTags = (0, exports.sanitizeStringList)(options.excludedTags)?.slice(0, 10);
    if (excludedTags?.length) {
        payload.excludedTags = excludedTags;
    }
    if (typeof options.removeOverlayElements === "boolean") {
        payload.removeOverlayElements = options.removeOverlayElements;
    }
    if (typeof options.wordCountThreshold === "number") {
        payload.wordCountThreshold = options.wordCountThreshold;
    }
    return Object.keys(payload).length
        ? payload
        : undefined;
};
exports.sanitizeCleanMarkdown = sanitizeCleanMarkdown;
const sanitizeLinkPreview = (preview) => {
    if (!preview) {
        return undefined;
    }
    const payload = {};
    if (typeof preview.includeInternal === "boolean") {
        payload.includeInternal = preview.includeInternal;
    }
    if (typeof preview.includeExternal === "boolean") {
        payload.includeExternal = preview.includeExternal;
    }
    if (typeof preview.includeSocial === "boolean") {
        payload.includeSocial = preview.includeSocial;
    }
    if (typeof preview.maxLinks === "number") {
        payload.maxLinks = preview.maxLinks;
    }
    if (typeof preview.concurrency === "number") {
        payload.concurrency = preview.concurrency;
    }
    if (typeof preview.timeoutSeconds === "number") {
        payload.timeoutSeconds = preview.timeoutSeconds;
    }
    if (typeof preview.query === "string" && preview.query.trim().length > 0) {
        payload.query = preview.query.trim();
    }
    if (typeof preview.scoreThreshold === "number") {
        payload.scoreThreshold = preview.scoreThreshold;
    }
    if (typeof preview.verbose === "boolean") {
        payload.verbose = preview.verbose;
    }
    const includePatterns = (0, exports.sanitizeStringList)(preview.includePatterns);
    if (includePatterns?.length) {
        payload.includePatterns = includePatterns;
    }
    const excludePatterns = (0, exports.sanitizeStringList)(preview.excludePatterns);
    if (excludePatterns?.length) {
        payload.excludePatterns = excludePatterns;
    }
    return Object.keys(payload).length
        ? payload
        : undefined;
};
exports.sanitizeLinkPreview = sanitizeLinkPreview;
const sanitizeBrowserHeaders = (headers) => {
    if (!headers || headers.length === 0) {
        return undefined;
    }
    const normalized = headers
        .map((header) => ({
        name: header?.name?.trim() ?? "",
        value: header?.value?.trim() ?? "",
    }))
        .filter((entry) => entry.name.length && entry.value.length)
        .slice(0, 20);
    return normalized.length ? normalized : undefined;
};
exports.sanitizeBrowserHeaders = sanitizeBrowserHeaders;
const sanitizeBrowserCookies = (cookies) => {
    if (!cookies || cookies.length === 0) {
        return undefined;
    }
    const normalized = cookies
        .map((cookie) => ({
        name: cookie?.name?.trim() ?? "",
        value: cookie?.value?.trim() ?? "",
        domain: cookie?.domain?.trim() ?? "",
        path: cookie?.path?.trim() || undefined,
    }))
        .filter((entry) => entry.name.length && entry.value.length && entry.domain.length)
        .slice(0, 20);
    return normalized.length ? normalized : undefined;
};
exports.sanitizeBrowserCookies = sanitizeBrowserCookies;
const sanitizeUserAgentGenerator = (generator) => {
    if (!generator) {
        return undefined;
    }
    const normalized = {};
    const platforms = ["windows", "macos", "linux", "android", "ios"];
    const browsers = ["chrome", "firefox", "safari", "edge"];
    const deviceTypes = ["desktop", "mobile", "tablet"];
    if (generator.platform && platforms.includes(generator.platform)) {
        normalized.platform = generator.platform;
    }
    if (generator.browser && browsers.includes(generator.browser)) {
        normalized.browser = generator.browser;
    }
    if (generator.deviceType && deviceTypes.includes(generator.deviceType)) {
        normalized.deviceType = generator.deviceType;
    }
    if (generator.locale) {
        const trimmed = generator.locale.trim();
        if (trimmed.length) {
            normalized.locale = trimmed.slice(0, 16);
        }
    }
    return Object.keys(normalized).length ? normalized : undefined;
};
exports.sanitizeUserAgentGenerator = sanitizeUserAgentGenerator;
const sanitizeGeolocation = (geo) => {
    if (!geo) {
        return undefined;
    }
    const latitude = typeof geo.latitude === "number" ? geo.latitude : undefined;
    const longitude = typeof geo.longitude === "number" ? geo.longitude : undefined;
    if (latitude == null || longitude == null) {
        return undefined;
    }
    const normalized = {
        latitude: Math.max(-90, Math.min(90, Number(latitude.toFixed(6)))),
        longitude: Math.max(-180, Math.min(180, Number(longitude.toFixed(6)))),
    };
    if (typeof geo.accuracy === "number" && !Number.isNaN(geo.accuracy)) {
        normalized.accuracy = Math.max(1, Math.min(5000, Math.round(geo.accuracy)));
    }
    return normalized;
};
exports.sanitizeGeolocation = sanitizeGeolocation;
const sanitizeCrawlOptions = (values) => {
    const proxyConfigInput = values.proxyConfig;
    const proxyServer = proxyConfigInput?.server?.trim();
    const proxyConfig = proxyServer
        ? {
            server: proxyServer,
            username: proxyConfigInput?.username?.trim() || undefined,
            password: proxyConfigInput?.password?.trim() || undefined,
        }
        : undefined;
    const proxyUrl = proxyConfig ? undefined : values.proxyUrl?.trim();
    const additionalUrls = (0, exports.sanitizeStringList)(values.additionalUrls);
    const multiUrlConfigs = (0, exports.sanitizeMultiUrlConfigs)(values.multiUrlConfigs);
    const markdownOptions = (0, exports.sanitizeMarkdownOptions)(values.markdownOptions);
    const markdownFilter = (0, exports.sanitizeMarkdownFilter)(values.markdownFilter);
    const markdownStrategy = (0, exports.sanitizeMarkdownStrategy)(values.markdownStrategy);
    const tableExtraction = (0, exports.sanitizeTableExtraction)(values.tableExtraction);
    const cleanMarkdown = (0, exports.sanitizeCleanMarkdown)(values.cleanMarkdown);
    const linkPreview = (0, exports.sanitizeLinkPreview)(values.linkPreview);
    const jsCode = (0, exports.sanitizeJsCodeList)(values.jsCode);
    const waitForSelector = values.waitForSelector?.trim();
    const waitForScript = values.waitForScript?.trim();
    const sessionId = values.sessionId?.trim();
    const storageState = values.storageState?.trim();
    const userDataDir = values.userDataDir?.trim();
    const browserHeaders = (0, exports.sanitizeBrowserHeaders)(values.browserHeaders);
    const browserCookies = (0, exports.sanitizeBrowserCookies)(values.browserCookies);
    const userAgent = values.userAgent?.trim();
    const userAgentMode = values.userAgentMode === "random" ? "random" : undefined;
    const userAgentGenerator = (0, exports.sanitizeUserAgentGenerator)(values.userAgentGenerator);
    const locale = values.locale?.trim();
    const timezoneId = values.timezoneId?.trim();
    const geolocation = (0, exports.sanitizeGeolocation)(values.geolocation);
    const tableScoreThreshold = typeof values.tableScoreThreshold === "number"
        ? Number(Math.max(0, Math.min(10, values.tableScoreThreshold)).toFixed(2))
        : undefined;
    const options = {
        includeImages: values.includeImages ?? undefined,
        storeMedia: typeof values.storeMedia === "boolean" ? values.storeMedia : undefined,
        onlyMainContent: values.onlyMainContent ?? undefined,
        extractLinks: values.extractLinks ?? undefined,
        excludeExternalImages: typeof values.excludeExternalImages === "boolean"
            ? values.excludeExternalImages
            : undefined,
        scanFullPage: values.scanFullPage ?? undefined,
        adjustViewportToContent: typeof values.adjustViewportToContent === "boolean"
            ? values.adjustViewportToContent
            : undefined,
        scrollDelayMs: values.scrollDelayMs ?? undefined,
        headless: typeof values.headless === "boolean" ? values.headless : undefined,
        enableUndetectedBrowser: values.enableUndetectedBrowser ?? undefined,
        enableStealthMode: values.enableStealthMode ?? undefined,
        useManagedBrowser: typeof values.useManagedBrowser === "boolean"
            ? values.useManagedBrowser
            : undefined,
        userDataDir: userDataDir && userDataDir.length ? userDataDir : undefined,
        simulateUser: values.simulateUser ?? undefined,
        overrideNavigator: values.overrideNavigator ?? undefined,
        jsCode: jsCode ?? undefined,
        jsOnly: typeof values.jsOnly === "boolean" ? values.jsOnly : undefined,
        waitForSelector: waitForSelector ? waitForSelector : undefined,
        waitForScript: waitForScript ? waitForScript : undefined,
        waitForTimeoutMs: values.waitForTimeoutMs ?? undefined,
        waitForImages: typeof values.waitForImages === "boolean"
            ? values.waitForImages
            : undefined,
        sessionId: sessionId ? sessionId : undefined,
        storageState: storageState && storageState.length ? storageState : undefined,
        proxyUrl: proxyUrl ? proxyUrl : undefined,
        proxyConfig: proxyConfig ?? undefined,
        additionalUrls: additionalUrls && additionalUrls.length ? additionalUrls : undefined,
        multiUrlConfigs,
        markdownOptions: markdownOptions ?? undefined,
        markdownFilter: markdownFilter ?? undefined,
        markdownStrategy: markdownStrategy ?? undefined,
        tableScoreThreshold,
        tableExtraction: tableExtraction ?? undefined,
        cleanMarkdown: cleanMarkdown ?? undefined,
        scoreLinks: typeof values.scoreLinks === "boolean" ? values.scoreLinks : undefined,
        linkPreview: linkPreview ?? undefined,
        browserHeaders: browserHeaders ?? undefined,
        browserCookies: browserCookies ?? undefined,
        userAgent: userAgent?.length ? userAgent : undefined,
        userAgentMode: userAgentMode ?? undefined,
        userAgentGenerator: userAgentGenerator ?? undefined,
        locale: locale?.length ? locale : undefined,
        timezoneId: timezoneId?.length ? timezoneId : undefined,
        geolocation: geolocation ?? undefined,
    };
    return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
};
exports.sanitizeCrawlOptions = sanitizeCrawlOptions;
//# sourceMappingURL=crawl.js.map
