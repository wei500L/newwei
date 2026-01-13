"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogger = void 0;
const pino_1 = __importDefault(require("pino"));
const tracing_1 = require("./tracing");
const createLogger = ({ name = "app", level, enabled = true } = {}) => {
    const isNodeRuntime = typeof process !== "undefined" &&
        typeof process.stdout !== "undefined" &&
        typeof process.versions?.node !== "undefined";
    if (!isNodeRuntime) {
        const prefix = `[${name}]`;
        const log = (method) => (...args) => {
            if (!enabled)
                return;
            // eslint-disable-next-line no-console
            console[method](prefix, ...args);
        };
        const consoleLogger = {
            fatal: log("error"),
            error: log("error"),
            warn: log("warn"),
            info: log("info"),
            debug: log("debug"),
            trace: log("debug"),
            child: () => consoleLogger
        };
        return consoleLogger;
    }
    const nodeEnv = typeof process !== "undefined" ? process.env?.NODE_ENV : undefined;
    const envLogLevel = typeof process !== "undefined" ? process.env?.LOG_LEVEL : undefined;
    const resolvedLevel = level ?? envLogLevel ?? (nodeEnv === "production" ? "info" : "debug");
    const stdoutIsTTY = typeof process !== "undefined" && typeof process.stdout !== "undefined" && typeof process.stdout.isTTY !== "undefined"
        ? Boolean(process.stdout.isTTY)
        : false;
    const usePrettyTransport = nodeEnv !== "production" && stdoutIsTTY;
    return (0, pino_1.default)({
        name,
        enabled,
        level: resolvedLevel,
        mixin: () => {
            const traceId = (0, tracing_1.getCurrentTraceId)();
            return traceId ? { traceId } : {};
        },
        transport: usePrettyTransport
            ? {
                target: "pino-pretty",
                options: {
                    colorize: true,
                    translateTime: "SYS:standard"
                }
            }
            : undefined
    });
};
exports.createLogger = createLogger;
//# sourceMappingURL=logger.js.map