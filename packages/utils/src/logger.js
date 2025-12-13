"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogger = void 0;
const pino_1 = __importDefault(require("pino"));
const tracing_1 = require("./tracing");
const createLogger = ({ name = "app", level = process.env.LOG_LEVEL, enabled = true } = {}) => {
    return (0, pino_1.default)({
        name,
        enabled,
        level: level ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
        mixin: () => {
            const traceId = (0, tracing_1.getCurrentTraceId)();
            return traceId ? { traceId } : {};
        },
        transport: process.env.NODE_ENV !== "production"
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