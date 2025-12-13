export declare const getCurrentTraceId: () => string | undefined;
export declare const ensureTraceId: (incoming?: string | null) => string;
export declare const runWithTraceId: <T>(traceId: string, callback: () => T) => T;
export declare const bindTraceId: <TArgs extends unknown[], TResult>(traceId: string, fn: (...args: TArgs) => TResult) => ((...args: TArgs) => TResult);
//# sourceMappingURL=tracing.d.ts.map