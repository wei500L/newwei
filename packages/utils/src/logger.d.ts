import pino from "pino";
export interface CreateLoggerOptions {
    name?: string;
    level?: pino.LevelWithSilent;
    enabled?: boolean;
}
export declare const createLogger: ({ name, level, enabled }?: CreateLoggerOptions) => import("pino").Logger<never>;
export type Logger = ReturnType<typeof createLogger>;
//# sourceMappingURL=logger.d.ts.map