export declare enum CommonTimeZone {
    UTC = "UTC",
    AsiaShanghai = "Asia/Shanghai"
}
export declare enum DatePrecision {
    Year = "year",
    Quarter = "quarter",
    Month = "month",
    Day = "day",
    Minute = "minute",
    Second = "second",
    Millisecond = "millisecond"
}
export declare enum ParseDateFallback {
    Null = "null",
    Now = "now",
    Throw = "throw"
}
export type DateInput = Date | string | number;
export interface FormatDateTimeOptions {
    timeZone?: string;
}
export interface ParseDateTimeOptions {
    timeZone?: string;
    fallback?: ParseDateFallback;
}
export interface ParsedDateTime {
    date: Date;
    precision: DatePrecision;
    timeZone: string | null;
    source: string;
}
export interface DateRange {
    start: Date;
    endExclusive: Date;
    precision: DatePrecision.Year | DatePrecision.Quarter | DatePrecision.Month;
    timeZone: string;
    source: string;
}
export declare const isValidDate: (value: Date) => boolean;
export declare const formatDateTime: (date: DateInput, locale?: Intl.LocalesArgument, options?: FormatDateTimeOptions) => string;
export declare const toISODate: (date: DateInput) => string;
export declare const durationInSeconds: (start: DateInput, end?: DateInput) => number;
export declare const getTimeZoneOffsetMs: (date: Date, timeZone: string) => number;
export declare const toISODateString: (date: DateInput, timeZone?: string) => string;
export declare const toISODateTimeString: (date: DateInput, timeZone?: string) => string;
export declare const parseDateTimeDetailed: (value: unknown, options?: ParseDateTimeOptions) => ParsedDateTime | null;
export declare const parseDateTime: (value: unknown, options?: ParseDateTimeOptions) => Date | null;
export declare const parseDateRange: (value: string, options?: ParseDateTimeOptions) => DateRange | null;
//# sourceMappingURL=date.d.ts.map