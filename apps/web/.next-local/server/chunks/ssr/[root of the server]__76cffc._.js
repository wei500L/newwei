module.exports = {

"[externals]/ [external] (next/dist/compiled/next-server/app-page.runtime.dev.js, cjs)": (function({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__, m: module, e: exports, t: require }) { !function() {

const mod = __turbopack_external_require__("next/dist/compiled/next-server/app-page.runtime.dev.js");

module.exports = mod;

}.call(this) }),
"[externals]/ [external] (crypto, cjs)": (function({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__, m: module, e: exports, t: require }) { !function() {

const mod = __turbopack_external_require__("crypto");

module.exports = mod;

}.call(this) }),
"[externals]/ [external] (next/dist/client/components/request-async-storage.external.js, cjs)": (function({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__, m: module, e: exports, t: require }) { !function() {

const mod = __turbopack_external_require__("next/dist/client/components/request-async-storage.external.js");

module.exports = mod;

}.call(this) }),
"[externals]/ [external] (next/dist/client/components/static-generation-async-storage.external.js, cjs)": (function({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__, m: module, e: exports, t: require }) { !function() {

const mod = __turbopack_external_require__("next/dist/client/components/static-generation-async-storage.external.js");

module.exports = mod;

}.call(this) }),
"[externals]/ [external] (next/dist/client/components/action-async-storage.external.js, cjs)": (function({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__, m: module, e: exports, t: require }) { !function() {

const mod = __turbopack_external_require__("next/dist/client/components/action-async-storage.external.js");

module.exports = mod;

}.call(this) }),
"[project]/apps/web/lib/server-logger.ts [app-rsc] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "logServerError": ()=>logServerError
});
const serializeError = (error)=>{
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack
        };
    }
    return error;
};
const logServerError = (message, error, context = {})=>{
    console.error(message, {
        err: serializeError(error),
        traceId: context.traceId,
        meta: context.meta
    });
};

})()),
"[project]/apps/web/lib/env.ts [app-rsc] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "env": ()=>env
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zod$40$3$2e$25$2e$76$2f$node_modules$2f$zod$2f$v3$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/external.js [app-rsc] (ecmascript) <export * as z>");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$server$2d$logger$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/apps/web/lib/server-logger.ts [app-rsc] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
const publicSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zod$40$3$2e$25$2e$76$2f$node_modules$2f$zod$2f$v3$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
    NEXT_PUBLIC_API_BASE_URL: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zod$40$3$2e$25$2e$76$2f$node_modules$2f$zod$2f$v3$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().url()
});
const serverSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zod$40$3$2e$25$2e$76$2f$node_modules$2f$zod$2f$v3$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
    API_BASE_URL: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zod$40$3$2e$25$2e$76$2f$node_modules$2f$zod$2f$v3$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().url().optional()
});
const isServer = "undefined" === "undefined";
const publicParsed = publicSchema.safeParse({
    NEXT_PUBLIC_API_BASE_URL: ("TURBOPACK compile-time value", "http://localhost:4000/api")
});
if (!publicParsed.success) {
    const fieldErrors = publicParsed.error.flatten().fieldErrors;
    if ("TURBOPACK compile-time truthy", 1) {
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$server$2d$logger$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["logServerError"])("Invalid web environment configuration", publicParsed.error, {
            meta: fieldErrors
        });
    } else {
        "TURBOPACK unreachable";
    }
    throw new Error("Invalid web environment configuration");
}
const publicEnvValues = publicParsed.data;
const serverParsed = ("TURBOPACK compile-time truthy", 1) ? serverSchema.safeParse({
    API_BASE_URL: process.env.API_BASE_URL
}) : ("TURBOPACK unreachable", undefined);
if (isServer && serverParsed && !serverParsed.success) {
    const fieldErrors = serverParsed.error.flatten().fieldErrors;
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$server$2d$logger$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["logServerError"])("Invalid web environment configuration", serverParsed.error, {
        meta: fieldErrors
    });
    throw new Error("Invalid web environment configuration");
}
const publicApiBaseUrl = publicEnvValues.NEXT_PUBLIC_API_BASE_URL.endsWith("/api") ? publicEnvValues.NEXT_PUBLIC_API_BASE_URL : `${publicEnvValues.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, "")}/api`;
const publicApiRoot = publicApiBaseUrl.endsWith("/api") ? publicApiBaseUrl.slice(0, -4) : publicApiBaseUrl;
const internalApiRootRaw = isServer && serverParsed && serverParsed.success ? serverParsed.data.API_BASE_URL ?? publicApiRoot : publicApiRoot;
const internalApiBaseUrl = internalApiRootRaw.endsWith("/api") ? internalApiRootRaw : `${internalApiRootRaw.replace(/\/$/, "")}/api`;
const internalApiRoot = internalApiBaseUrl.endsWith("/api") ? internalApiBaseUrl.slice(0, -4) : internalApiBaseUrl;
const apiBaseUrl = ("TURBOPACK compile-time truthy", 1) ? internalApiBaseUrl : ("TURBOPACK unreachable", undefined);
const apiRoot = ("TURBOPACK compile-time truthy", 1) ? internalApiRoot : ("TURBOPACK unreachable", undefined);
const graphqlUrl = `${apiRoot}/graphql`;
const env = {
    ...publicEnvValues,
    apiBaseUrl,
    apiRoot,
    graphqlUrl
};

})()),
"[project]/apps/web/lib/env.server.ts [app-rsc] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "serverEnv": ()=>serverEnv
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$3_$5f$react$40$19$2e$2$2e$3$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$server$2d$only$2f$empty$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/next@15.0.0-canary.45_@babel+core@7.28.5_react-dom@19.2.3_react@19.2.3__react@19.2.3/node_modules/next/dist/compiled/server-only/empty.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zod$40$3$2e$25$2e$76$2f$node_modules$2f$zod$2f$v3$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/external.js [app-rsc] (ecmascript) <export * as z>");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$env$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/apps/web/lib/env.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$server$2d$logger$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/apps/web/lib/server-logger.ts [app-rsc] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
const serverSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zod$40$3$2e$25$2e$76$2f$node_modules$2f$zod$2f$v3$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
    NEXTAUTH_URL: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zod$40$3$2e$25$2e$76$2f$node_modules$2f$zod$2f$v3$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().url(),
    NEXTAUTH_SECRET: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$zod$40$3$2e$25$2e$76$2f$node_modules$2f$zod$2f$v3$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(16)
});
const parsed = serverSchema.safeParse({
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET
});
if (!parsed.success) {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$server$2d$logger$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["logServerError"])("Invalid web environment configuration", parsed.error, {
        meta: parsed.error.flatten().fieldErrors
    });
    throw new Error("Invalid web environment configuration");
}
const serverEnv = {
    ...__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$env$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["env"],
    ...parsed.data
};

})()),
"[project]/apps/web/lib/trace.ts [app-rsc] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "createTraceHeaders": ()=>createTraceHeaders,
    "getClientTraceId": ()=>getClientTraceId
});
let cachedTraceId;
const randomHex = (bytes)=>{
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
        const array = new Uint8Array(bytes);
        globalThis.crypto.getRandomValues(array);
        return Array.from(array, (value)=>value.toString(16).padStart(2, '0')).join('');
    }
    return Array.from({
        length: bytes
    }, ()=>Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
};
const ensureTraceId = (incoming)=>{
    const normalized = incoming?.trim().replace(/[^a-fA-F0-9]/g, '');
    if (normalized && normalized.length >= 16) {
        return normalized.slice(0, 32);
    }
    return randomHex(16);
};
const normalizeHeaders = (headers)=>{
    if (!headers) {
        return {};
    }
    if (headers instanceof Headers) {
        const normalized = {};
        headers.forEach((value, key)=>{
            normalized[key.toLowerCase()] = value;
        });
        return normalized;
    }
    if (Array.isArray(headers)) {
        return headers.reduce((acc, [key, value])=>{
            acc[String(key).toLowerCase()] = String(value);
            return acc;
        }, {});
    }
    return Object.entries(headers).reduce((acc, [key, value])=>{
        acc[key.toLowerCase()] = String(value);
        return acc;
    }, {});
};
const getClientTraceId = ()=>{
    if ("TURBOPACK compile-time truthy", 1) {
        return ensureTraceId();
    }
    if (!cachedTraceId) {
        cachedTraceId = ensureTraceId(window.__traceId);
        window.__traceId = cachedTraceId;
    }
    return cachedTraceId;
};
const createTraceHeaders = (headers)=>{
    const normalized = normalizeHeaders(headers);
    const traceId = ensureTraceId(normalized['x-trace-id'] ?? getClientTraceId());
    return {
        ...normalized,
        'x-trace-id': traceId,
        traceparent: normalized.traceparent ?? `00-${traceId}-0000000000000000-01`
    };
};

})()),
"[project]/apps/web/lib/auth.ts [app-rsc] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "auth": ()=>auth,
    "handlers": ()=>handlers,
    "signIn": ()=>signIn,
    "signOut": ()=>signOut
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$2d$auth$40$5$2e$0$2e$0$2d$beta$2e$30_next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$_horqxjb54bew3wmv2xcafng3r4$2f$node_modules$2f$next$2d$auth$2f$index$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/next-auth@5.0.0-beta.30_next@15.0.0-canary.45_@babel+core@7.28.5_react-dom@19.2.3_react@19.2._horqxjb54bew3wmv2xcafng3r4/node_modules/next-auth/index.js [app-rsc] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$2d$auth$40$5$2e$0$2e$0$2d$beta$2e$30_next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$_horqxjb54bew3wmv2xcafng3r4$2f$node_modules$2f$next$2d$auth$2f$index$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/next-auth@5.0.0-beta.30_next@15.0.0-canary.45_@babel+core@7.28.5_react-dom@19.2.3_react@19.2._horqxjb54bew3wmv2xcafng3r4/node_modules/next-auth/index.js [app-rsc] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$2d$auth$40$5$2e$0$2e$0$2d$beta$2e$30_next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$_horqxjb54bew3wmv2xcafng3r4$2f$node_modules$2f$next$2d$auth$2f$providers$2f$credentials$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/next-auth@5.0.0-beta.30_next@15.0.0-canary.45_@babel+core@7.28.5_react-dom@19.2.3_react@19.2._horqxjb54bew3wmv2xcafng3r4/node_modules/next-auth/providers/credentials.js [app-rsc] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$auth$2b$core$40$0$2e$41$2e$0$2f$node_modules$2f40$auth$2f$core$2f$providers$2f$credentials$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/@auth+core@0.41.0/node_modules/@auth/core/providers/credentials.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$env$2e$server$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/apps/web/lib/env.server.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$server$2d$logger$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/apps/web/lib/server-logger.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$trace$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/apps/web/lib/trace.ts [app-rsc] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
;
const REFRESH_TOKEN_TIMEOUT_MS = 5_000;
const LOGIN_TIMEOUT_MS = 8_000;
function normalizeOptionalId(value) {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed === "undefined" || trimmed === "null") return undefined;
    return trimmed;
}
async function refreshAccessToken(token) {
    let traceId;
    const controller = new AbortController();
    const timeoutId = setTimeout(()=>controller.abort(), REFRESH_TOKEN_TIMEOUT_MS);
    try {
        const response = await fetch(`${__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$env$2e$server$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["serverEnv"].apiBaseUrl}/auth/refresh`, {
            method: "POST",
            headers: (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$trace$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["createTraceHeaders"])({
                "Content-Type": "application/json"
            }),
            body: JSON.stringify({
                refreshToken: token.refreshToken,
                orgId: token.user.orgId
            }),
            signal: controller.signal
        });
        traceId = response.headers.get("x-trace-id") ?? undefined;
        if (!response.ok) {
            const errorText = await response.text().catch(()=>"Failed to refresh token");
            if (response.status === 401 || response.status === 403) {
                console.warn("Refresh token rejected", {
                    traceId,
                    meta: {
                        userId: token.user.id,
                        status: response.status
                    }
                });
                return {
                    ...token,
                    accessToken: "",
                    refreshToken: "",
                    accessTokenExpires: 0,
                    error: "RefreshAccessTokenError"
                };
            }
            throw new Error(errorText || "Failed to refresh token");
        }
        const data = await response.json();
        return {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken ?? token.refreshToken,
            accessTokenExpires: Date.now() + data.expiresIn * 1000,
            user: data.user,
            organizations: data.organizations ?? token.organizations ?? [
                {
                    id: data.user.orgId
                }
            ]
        };
    } catch (error) {
        const isAbortError = error instanceof Error && error.name === "AbortError";
        const meta = {
            userId: token.user.id
        };
        if (isAbortError) {
            meta.reason = "refresh_token_timeout";
            meta.timeoutMs = REFRESH_TOKEN_TIMEOUT_MS;
        }
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$server$2d$logger$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["logServerError"])("Refresh token error", error, {
            traceId,
            meta
        });
        return {
            ...token,
            accessToken: "",
            refreshToken: "",
            accessTokenExpires: 0,
            error: "RefreshAccessTokenError"
        };
    } finally{
        clearTimeout(timeoutId);
    }
}
const config = {
    trustHost: true,
    debug: process.env.NEXTAUTH_DEBUG === "1" || process.env.NEXTAUTH_DEBUG === "true",
    secret: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$env$2e$server$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["serverEnv"].NEXTAUTH_SECRET,
    session: {
        strategy: "jwt"
    },
    pages: {
        signIn: "/login"
    },
    providers: [
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f40$auth$2b$core$40$0$2e$41$2e$0$2f$node_modules$2f40$auth$2f$core$2f$providers$2f$credentials$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"])({
            name: "Credentials",
            credentials: {
                email: {
                    label: "Email",
                    type: "email"
                },
                password: {
                    label: "Password",
                    type: "password"
                },
                orgId: {
                    label: "Organization",
                    type: "text",
                    required: false
                }
            },
            async authorize (credentials) {
                if (!credentials?.email || !credentials?.password) {
                    return null;
                }
                const controller = new AbortController();
                const timeoutId = setTimeout(()=>controller.abort(), LOGIN_TIMEOUT_MS);
                const orgId = normalizeOptionalId(credentials.orgId);
                const loginUrl = `${__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$env$2e$server$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["serverEnv"].apiBaseUrl}/auth/login`;
                try {
                    const response = await fetch(loginUrl, {
                        method: "POST",
                        headers: (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$trace$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["createTraceHeaders"])({
                            "Content-Type": "application/json"
                        }),
                        body: JSON.stringify({
                            email: credentials.email,
                            password: credentials.password,
                            orgId
                        }),
                        signal: controller.signal
                    });
                    const traceId = response.headers.get("x-trace-id") ?? undefined;
                    if (!response.ok) {
                        const errorText = await response.text().catch(()=>"Backend login failed");
                        (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$server$2d$logger$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["logServerError"])("Credentials sign-in rejected by backend", new Error(errorText), {
                            traceId,
                            meta: {
                                status: response.status,
                                url: loginUrl,
                                email: credentials.email,
                                orgId: orgId ?? null
                            }
                        });
                        return null;
                    }
                    const data = await response.json();
                    const organizations = data.organizations ?? [
                        {
                            id: data.user.orgId
                        }
                    ];
                    return {
                        id: data.user.id,
                        email: data.user.email,
                        name: `${data.user.firstName} ${data.user.lastName}`,
                        ...data,
                        organizations
                    };
                } catch (error) {
                    const isAbortError = error instanceof Error && error.name === "AbortError";
                    (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$server$2d$logger$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["logServerError"])("Credentials sign-in request failed", error, {
                        meta: {
                            reason: isAbortError ? "timeout" : "fetch_error",
                            timeoutMs: LOGIN_TIMEOUT_MS,
                            url: loginUrl,
                            email: credentials.email,
                            orgId: orgId ?? null
                        }
                    });
                    return null;
                } finally{
                    clearTimeout(timeoutId);
                }
            }
        })
    ],
    callbacks: {
        authorized ({ auth }) {
            const session = auth;
            return !!session && session.error !== "RefreshAccessTokenError";
        },
        async jwt ({ token, user, trigger, session }) {
            if (user) {
                const typedUser = user;
                return {
                    accessToken: typedUser.accessToken,
                    refreshToken: typedUser.refreshToken,
                    accessTokenExpires: Date.now() + typedUser.expiresIn * 1000,
                    user: typedUser.user,
                    organizations: typedUser.organizations ?? [
                        {
                            id: typedUser.user.orgId
                        }
                    ]
                };
            }
            const typedToken = token;
            if (trigger === "update" && session) {
                const updatedSession = session;
                return {
                    ...typedToken,
                    accessToken: updatedSession.accessToken ?? typedToken.accessToken,
                    refreshToken: updatedSession.refreshToken ?? typedToken.refreshToken,
                    accessTokenExpires: updatedSession.accessTokenExpires ?? typedToken.accessTokenExpires,
                    user: updatedSession.user ?? typedToken.user,
                    organizations: updatedSession.organizations ?? typedToken.organizations
                };
            }
            if (typedToken.error === "RefreshAccessTokenError") {
                return {
                    ...typedToken,
                    accessToken: "",
                    refreshToken: "",
                    accessTokenExpires: 0
                };
            }
            if (Date.now() < typedToken.accessTokenExpires - 30_000) {
                return typedToken;
            }
            return refreshAccessToken(typedToken);
        },
        async session ({ session, token }) {
            const typedToken = token;
            return {
                ...session,
                user: {
                    ...typedToken.user,
                    organizations: typedToken.organizations,
                    image: typedToken.user.avatarUrl ?? null
                },
                accessToken: typedToken.accessToken,
                accessTokenExpires: typedToken.accessTokenExpires,
                permissions: typedToken.user.permissions,
                orgId: typedToken.user.orgId,
                organizations: typedToken.organizations ?? [
                    {
                        id: typedToken.user.orgId
                    }
                ],
                error: typedToken.error
            };
        }
    }
};
const { handlers, auth, signIn, signOut } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$2d$auth$40$5$2e$0$2e$0$2d$beta$2e$30_next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$_horqxjb54bew3wmv2xcafng3r4$2f$node_modules$2f$next$2d$auth$2f$index$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$locals$3e$__["default"])(config);

})()),
"[project]/apps/web/app/providers.tsx (client proxy)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "AppProviders": ()=>AppProviders
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$3_$5f$react$40$19$2e$2$2e$3$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2d$edge$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/next@15.0.0-canary.45_@babel+core@7.28.5_react-dom@19.2.3_react@19.2.3__react@19.2.3/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-server-dom-turbopack-server-edge.js [app-rsc] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
const AppProviders = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$3_$5f$react$40$19$2e$2$2e$3$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2d$edge$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["registerClientReference"])(function() {
    throw new Error("Attempted to call AppProviders() from the server but AppProviders is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.");
}, "[project]/apps/web/app/providers.tsx", "AppProviders");

})()),
"[project]/apps/web/app/providers.tsx [app-rsc] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$app$2f$providers$2e$tsx__$28$client__proxy$29$__ = __turbopack_import__("[project]/apps/web/app/providers.tsx (client proxy)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
__turbopack_export_namespace__(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$app$2f$providers$2e$tsx__$28$client__proxy$29$__);

})()),
"[project]/apps/web/app/session-provider.tsx (client proxy)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "SessionProviders": ()=>SessionProviders
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$3_$5f$react$40$19$2e$2$2e$3$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2d$edge$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/next@15.0.0-canary.45_@babel+core@7.28.5_react-dom@19.2.3_react@19.2.3__react@19.2.3/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-server-dom-turbopack-server-edge.js [app-rsc] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
const SessionProviders = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$3_$5f$react$40$19$2e$2$2e$3$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2d$edge$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["registerClientReference"])(function() {
    throw new Error("Attempted to call SessionProviders() from the server but SessionProviders is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.");
}, "[project]/apps/web/app/session-provider.tsx", "SessionProviders");

})()),
"[project]/apps/web/app/session-provider.tsx [app-rsc] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$app$2f$session$2d$provider$2e$tsx__$28$client__proxy$29$__ = __turbopack_import__("[project]/apps/web/app/session-provider.tsx (client proxy)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
__turbopack_export_namespace__(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$app$2f$session$2d$provider$2e$tsx__$28$client__proxy$29$__);

})()),
"[project]/apps/web/app/layout.tsx [app-rsc] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "default": ()=>RootLayout,
    "metadata": ()=>metadata
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$3_$5f$react$40$19$2e$2$2e$3$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/next@15.0.0-canary.45_@babel+core@7.28.5_react-dom@19.2.3_react@19.2.3__react@19.2.3/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$auth$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/apps/web/lib/auth.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$app$2f$providers$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/apps/web/app/providers.tsx [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$app$2f$session$2d$provider$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/apps/web/app/session-provider.tsx [app-rsc] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
;
;
;
;
const metadata = {
    title: "Modular Admin",
    description: "Operator dashboard"
};
async function RootLayout({ children }) {
    const session = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$lib$2f$auth$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["auth"])();
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$3_$5f$react$40$19$2e$2$2e$3$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("html", {
        lang: "en",
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$3_$5f$react$40$19$2e$2$2e$3$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("body", {
            className: "font-sans bg-background text-foreground antialiased",
            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$3_$5f$react$40$19$2e$2$2e$3$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$app$2f$session$2d$provider$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SessionProviders"], {
                session: session,
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$3_$5f$react$40$19$2e$2$2e$3$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$app$2f$providers$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AppProviders"], {
                    children: children
                }, void 0, false, {
                    fileName: "[project]/apps/web/app/layout.tsx",
                    lineNumber: 20,
                    columnNumber: 11
                }, this)
            }, void 0, false, {
                fileName: "[project]/apps/web/app/layout.tsx",
                lineNumber: 19,
                columnNumber: 9
            }, this)
        }, void 0, false, {
            fileName: "[project]/apps/web/app/layout.tsx",
            lineNumber: 18,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/apps/web/app/layout.tsx",
        lineNumber: 17,
        columnNumber: 5
    }, this);
}

})()),
"[project]/apps/web/app/layout.tsx [app-rsc] (ecmascript, Next.js server component)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {

__turbopack_esm__({
    default: () => __turbopack_import__("[project]/apps/web/app/layout.tsx [app-rsc] (ecmascript)"),
});

})()),
"[project]/apps/web/app/page.tsx [app-rsc] (ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "default": ()=>RootPage
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$3_$5f$react$40$19$2e$2$2e$3$2f$node_modules$2f$next$2f$dist$2f$api$2f$navigation$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_import__("[project]/node_modules/.pnpm/next@15.0.0-canary.45_@babel+core@7.28.5_react-dom@19.2.3_react@19.2.3__react@19.2.3/node_modules/next/dist/api/navigation.react-server.js [app-rsc] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$3_$5f$react$40$19$2e$2$2e$3$2f$node_modules$2f$next$2f$dist$2f$client$2f$components$2f$navigation$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_import__("[project]/node_modules/.pnpm/next@15.0.0-canary.45_@babel+core@7.28.5_react-dom@19.2.3_react@19.2.3__react@19.2.3/node_modules/next/dist/client/components/navigation.react-server.js [app-rsc] (ecmascript)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
function RootPage() {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f2e$pnpm$2f$next$40$15$2e$0$2e$0$2d$canary$2e$45_$40$babel$2b$core$40$7$2e$28$2e$5_react$2d$dom$40$19$2e$2$2e$3_react$40$19$2e$2$2e$3_$5f$react$40$19$2e$2$2e$3$2f$node_modules$2f$next$2f$dist$2f$client$2f$components$2f$navigation$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["redirect"])("/today");
}

})()),
"[project]/apps/web/app/page.tsx [app-rsc] (ecmascript, Next.js server component)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {

__turbopack_esm__({
    default: () => __turbopack_import__("[project]/apps/web/app/page.tsx [app-rsc] (ecmascript)"),
});

})()),
"[externals]/ [external] (path, cjs)": (function({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__, m: module, e: exports, t: require }) { !function() {

const mod = __turbopack_external_require__("path");

module.exports = mod;

}.call(this) }),
"[externals]/ [external] (url, cjs)": (function({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__, m: module, e: exports, t: require }) { !function() {

const mod = __turbopack_external_require__("url");

module.exports = mod;

}.call(this) }),
"[project]/apps/web/app/icon.svg [app-rsc] (static)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname }) => (() => {

__turbopack_export_value__("/_next/static/media/icon.43aa9765.svg");
})()),
"[project]/apps/web/app/icon.svg.mjs { IMAGE => \"[project]/apps/web/app/icon.svg [app-rsc] (static)\" } [app-rsc] (structured image object, ecmascript)": (({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__ }) => (() => {
"use strict";

__turbopack_esm__({
    "default": ()=>__TURBOPACK__default__export__
});
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$app$2f$icon$2e$svg__$5b$app$2d$rsc$5d$__$28$static$29$__ = __turbopack_import__("[project]/apps/web/app/icon.svg [app-rsc] (static)");
"__TURBOPACK__ecmascript__hoisting__location__";
;
const __TURBOPACK__default__export__ = {
    src: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$web$2f$app$2f$icon$2e$svg__$5b$app$2d$rsc$5d$__$28$static$29$__["default"],
    width: 64,
    height: 64
};

})()),
"[externals]/ [external] (@opentelemetry/api, cjs)": (function({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__, m: module, e: exports, t: require }) { !function() {

const mod = __turbopack_external_require__("@opentelemetry/api");

module.exports = mod;

}.call(this) }),
"[externals]/ [external] (async_hooks, cjs)": (function({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__, m: module, e: exports, t: require }) { !function() {

const mod = __turbopack_external_require__("async_hooks");

module.exports = mod;

}.call(this) }),
"[project]/apps/web/.next-internal/server/app/page/actions.js [app-rsc] (ecmascript)": (function({ r: __turbopack_require__, f: __turbopack_module_context__, i: __turbopack_import__, s: __turbopack_esm__, v: __turbopack_export_value__, n: __turbopack_export_namespace__, c: __turbopack_cache__, M: __turbopack_modules__, l: __turbopack_load__, j: __turbopack_dynamic__, P: __turbopack_resolve_absolute_path__, U: __turbopack_relative_url__, R: __turbopack_resolve_module_id_path__, g: global, __dirname, x: __turbopack_external_require__, y: __turbopack_external_import__, m: module, e: exports, t: require }) { !function() {

__turbopack_export_value__({});

}.call(this) }),

};

//# sourceMappingURL=%5Broot%20of%20the%20server%5D__76cffc._.js.map