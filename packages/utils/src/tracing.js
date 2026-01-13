"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bindTraceId = exports.runWithTraceId = exports.ensureTraceId = exports.getCurrentTraceId = void 0;
const randomHex = (bytes) => {
    if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
        const array = new Uint8Array(bytes);
        globalThis.crypto.getRandomValues(array);
        return Array.from(array, (value) => value.toString(16).padStart(2, "0")).join("");
    }
    return Array.from({ length: bytes }, () => Math.floor(Math.random() * 256)
        .toString(16)
        .padStart(2, "0")).join("");
};
const createAsyncLocalStorage = () => {
    if (typeof window !== "undefined") {
        return undefined;
    }
    if (typeof process === "undefined" || !process.versions?.node) {
        return undefined;
    }
    try {
        // Avoid bundlers (e.g. Next/Webpack) trying to resolve node builtins for client bundles.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const dynamicRequire = eval("require");
        // eslint-disable-next-line @typescript-eslint/consistent-type-imports
        const { AsyncLocalStorage } = dynamicRequire("node:async_hooks");
        return new AsyncLocalStorage();
    }
    catch {
        return undefined;
    }
};
const traceStorage = createAsyncLocalStorage();
const getCurrentTraceId = () => {
    return traceStorage?.getStore()?.traceId;
};
exports.getCurrentTraceId = getCurrentTraceId;
const ensureTraceId = (incoming) => {
    const normalized = incoming?.trim().replace(/[^a-fA-F0-9]/g, "");
    if (normalized && normalized.length >= 16) {
        return normalized.slice(0, 32);
    }
    return randomHex(16);
};
exports.ensureTraceId = ensureTraceId;
const runWithTraceId = (traceId, callback) => {
    if (!traceStorage) {
        return callback();
    }
    return traceStorage.run({ traceId }, callback);
};
exports.runWithTraceId = runWithTraceId;
const bindTraceId = (traceId, fn) => {
    if (!traceStorage) {
        return (...args) => fn(...args);
    }
    return (...args) => traceStorage.run({ traceId }, () => fn(...args));
};
exports.bindTraceId = bindTraceId;
//# sourceMappingURL=tracing.js.map