import { type LevelWithSilent, type Logger as PinoLogger } from "pino";
export interface CreateLoggerOptions {
    name?: string;
    level?: LevelWithSilent;
    enabled?: boolean;
}
export declare const createLogger: ({ name, level, enabled }?: CreateLoggerOptions) => PinoLogger;
export type Logger = ReturnType<typeof createLogger>;
//# sourceMappingURL=logger.d.ts.map