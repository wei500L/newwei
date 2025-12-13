"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDateRange = exports.parseDateTime = exports.parseDateTimeDetailed = exports.toISODateTimeString = exports.toISODateString = exports.getTimeZoneOffsetMs = exports.durationInSeconds = exports.toISODate = exports.formatDateTime = exports.isValidDate = exports.ParseDateFallback = exports.DatePrecision = exports.CommonTimeZone = void 0;
var CommonTimeZone;
(function (CommonTimeZone) {
    CommonTimeZone["UTC"] = "UTC";
    CommonTimeZone["AsiaShanghai"] = "Asia/Shanghai";
})(CommonTimeZone || (exports.CommonTimeZone = CommonTimeZone = {}));
var DatePrecision;
(function (DatePrecision) {
    DatePrecision["Year"] = "year";
    DatePrecision["Quarter"] = "quarter";
    DatePrecision["Month"] = "month";
    DatePrecision["Day"] = "day";
    DatePrecision["Minute"] = "minute";
    DatePrecision["Second"] = "second";
    DatePrecision["Millisecond"] = "millisecond";
})(DatePrecision || (exports.DatePrecision = DatePrecision = {}));
var ParseDateFallback;
(function (ParseDateFallback) {
    ParseDateFallback["Null"] = "null";
    ParseDateFallback["Now"] = "now";
    ParseDateFallback["Throw"] = "throw";
})(ParseDateFallback || (exports.ParseDateFallback = ParseDateFallback = {}));
const dtfCache = new Map();
const getDtf = (timeZone) => {
    const cached = dtfCache.get(timeZone);
    if (cached) {
        return cached;
    }
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });
    dtfCache.set(timeZone, dtf);
    return dtf;
};
const getZonedParts = (date, timeZone) => {
    const parts = getDtf(timeZone).formatToParts(date);
    const byType = new Map();
    for (const part of parts) {
        byType.set(part.type, part.value);
    }
    const year = Number(byType.get('year'));
    const month = Number(byType.get('month'));
    const day = Number(byType.get('day'));
    const hour = Number(byType.get('hour'));
    const minute = Number(byType.get('minute'));
    const second = Number(byType.get('second'));
    const millisecond = date.getUTCMilliseconds();
    return {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millisecond,
    };
};
const isValidDate = (value) => Number.isFinite(value.getTime());
exports.isValidDate = isValidDate;
const formatDateTime = (date, locale = 'en-US', options = {}) => {
    const value = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
    return new Intl.DateTimeFormat(locale, {
        timeZone: options.timeZone,
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(value);
};
exports.formatDateTime = formatDateTime;
const toISODate = (date) => {
    const value = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
    return value.toISOString();
};
exports.toISODate = toISODate;
const durationInSeconds = (start, end = new Date()) => {
    const startValue = typeof start === 'string' || typeof start === 'number' ? new Date(start) : start;
    const endValue = typeof end === 'string' || typeof end === 'number' ? new Date(end) : end;
    return Math.round((endValue.getTime() - startValue.getTime()) / 1000);
};
exports.durationInSeconds = durationInSeconds;
const getTimeZoneOffsetMs = (date, timeZone) => {
    const parts = getZonedParts(date, timeZone);
    const asUtcMillis = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
    return asUtcMillis - date.getTime();
};
exports.getTimeZoneOffsetMs = getTimeZoneOffsetMs;
const pad2 = (value) => value.toString().padStart(2, '0');
const pad3 = (value) => value.toString().padStart(3, '0');
const toISODateString = (date, timeZone = CommonTimeZone.UTC) => {
    const value = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
    const parts = getZonedParts(value, timeZone);
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
};
exports.toISODateString = toISODateString;
const toISODateTimeString = (date, timeZone = CommonTimeZone.UTC) => {
    const value = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
    const parts = getZonedParts(value, timeZone);
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}.${pad3(parts.millisecond)}`;
};
exports.toISODateTimeString = toISODateTimeString;
const zonedTimeToUtc = (parts, timeZone) => {
    const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
    let utcMillis = localAsUtc;
    for (let i = 0; i < 3; i += 1) {
        const offset = (0, exports.getTimeZoneOffsetMs)(new Date(utcMillis), timeZone);
        const candidate = localAsUtc - offset;
        if (candidate === utcMillis) {
            break;
        }
        utcMillis = candidate;
    }
    return new Date(utcMillis);
};
const parseUnixTimestamp = (value) => {
    const trimmed = value.trim();
    if (!/^\d{10,13}$/.test(trimmed)) {
        return null;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
        return null;
    }
    const millis = trimmed.length <= 10 ? numeric * 1000 : numeric;
    const date = new Date(millis);
    return (0, exports.isValidDate)(date) ? date : null;
};
const hasExplicitTimeZone = (value) => /([zZ]|[+-]\d{2}:?\d{2})$/.test(value.trim()) || /\bGMT\b/i.test(value);
const parseNaiveDateTimeString = (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
        return null;
    }
    const quarterMatch = /^(\d{4})\s*(?:Q([1-4])|第\s*([1-4])\s*季度)$/.exec(trimmed) ??
        /^(\d{4})\s*年\s*(?:Q([1-4])|第\s*([1-4])\s*季度)$/.exec(trimmed);
    if (quarterMatch) {
        const year = Number(quarterMatch[1]);
        const quarter = Number(quarterMatch[2] ?? quarterMatch[3]);
        const month = (quarter - 1) * 3 + 1;
        return {
            parts: { year, month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 },
            precision: DatePrecision.Quarter,
        };
    }
    const chineseMatch = /^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日?)?(?:\s*(\d{1,2})(?:[:时]\s*(\d{1,2}))?(?:[:分]\s*(\d{1,2}))?(?:\.(\d{1,3}))?\s*(?:秒)?)?\s*$/.exec(trimmed);
    if (chineseMatch) {
        const year = Number(chineseMatch[1]);
        const month = Number(chineseMatch[2]);
        const dayRaw = chineseMatch[3];
        const hourRaw = chineseMatch[4];
        const minuteRaw = chineseMatch[5];
        const secondRaw = chineseMatch[6];
        const msRaw = chineseMatch[7];
        const hasTime = typeof hourRaw === 'string';
        const hasDay = typeof dayRaw === 'string';
        const precision = hasTime
            ? DatePrecision.Second
            : hasDay
                ? DatePrecision.Day
                : DatePrecision.Month;
        return {
            parts: {
                year,
                month,
                day: hasDay ? Number(dayRaw) : 1,
                hour: hasTime ? Number(hourRaw) : 0,
                minute: typeof minuteRaw === 'string' ? Number(minuteRaw) : 0,
                second: typeof secondRaw === 'string' ? Number(secondRaw) : 0,
                millisecond: typeof msRaw === 'string' ? Number(msRaw.padEnd(3, '0').slice(0, 3)) : 0,
            },
            precision,
        };
    }
    const ymdMatch = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?(?:\.(\d{1,3}))?)?\s*$/.exec(trimmed);
    if (ymdMatch) {
        const year = Number(ymdMatch[1]);
        const month = Number(ymdMatch[2]);
        const day = Number(ymdMatch[3]);
        const hourRaw = ymdMatch[4];
        const minuteRaw = ymdMatch[5];
        const secondRaw = ymdMatch[6];
        const msRaw = ymdMatch[7];
        const hasTime = typeof hourRaw === 'string';
        const precision = hasTime ? DatePrecision.Second : DatePrecision.Day;
        return {
            parts: {
                year,
                month,
                day,
                hour: hasTime ? Number(hourRaw) : 0,
                minute: typeof minuteRaw === 'string' ? Number(minuteRaw) : 0,
                second: typeof secondRaw === 'string' ? Number(secondRaw) : 0,
                millisecond: typeof msRaw === 'string' ? Number(msRaw.padEnd(3, '0').slice(0, 3)) : 0,
            },
            precision,
        };
    }
    const ymMatch = /^(\d{4})[-/.](\d{1,2})\s*$/.exec(trimmed);
    if (ymMatch) {
        const year = Number(ymMatch[1]);
        const month = Number(ymMatch[2]);
        return {
            parts: { year, month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 },
            precision: DatePrecision.Month,
        };
    }
    const yearMatch = /^(\d{4})\s*(?:年)?\s*$/.exec(trimmed);
    if (yearMatch) {
        const year = Number(yearMatch[1]);
        return {
            parts: { year, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 },
            precision: DatePrecision.Year,
        };
    }
    return null;
};
const resolveFallback = (fallback) => fallback ?? ParseDateFallback.Null;
const parseDateTimeDetailed = (value, options = {}) => {
    const fallback = resolveFallback(options.fallback);
    const timeZone = options.timeZone ?? CommonTimeZone.UTC;
    const handleInvalid = () => {
        switch (fallback) {
            case ParseDateFallback.Now:
                return { date: new Date(), precision: DatePrecision.Millisecond, timeZone: null, source: String(value ?? '') };
            case ParseDateFallback.Throw:
                throw new Error(`Invalid date input: ${String(value ?? '')}`);
            case ParseDateFallback.Null:
            default:
                return null;
        }
    };
    if (value instanceof Date) {
        return (0, exports.isValidDate)(value)
            ? { date: value, precision: DatePrecision.Millisecond, timeZone: null, source: value.toISOString() }
            : handleInvalid();
    }
    if (typeof value === 'number') {
        const millis = value < 1e12 ? value * 1000 : value;
        const date = new Date(millis);
        return (0, exports.isValidDate)(date)
            ? { date, precision: DatePrecision.Millisecond, timeZone: null, source: String(value) }
            : handleInvalid();
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return handleInvalid();
        }
        const numeric = parseUnixTimestamp(trimmed);
        if (numeric) {
            return { date: numeric, precision: DatePrecision.Millisecond, timeZone: null, source: trimmed };
        }
        if (hasExplicitTimeZone(trimmed)) {
            const date = new Date(trimmed);
            return (0, exports.isValidDate)(date)
                ? { date, precision: DatePrecision.Millisecond, timeZone: null, source: trimmed }
                : handleInvalid();
        }
        const naive = parseNaiveDateTimeString(trimmed);
        if (naive) {
            const date = zonedTimeToUtc(naive.parts, timeZone);
            return (0, exports.isValidDate)(date)
                ? { date, precision: naive.precision, timeZone, source: trimmed }
                : handleInvalid();
        }
        const fallbackDate = new Date(trimmed);
        return (0, exports.isValidDate)(fallbackDate)
            ? { date: fallbackDate, precision: DatePrecision.Millisecond, timeZone: null, source: trimmed }
            : handleInvalid();
    }
    return handleInvalid();
};
exports.parseDateTimeDetailed = parseDateTimeDetailed;
const parseDateTime = (value, options = {}) => (0, exports.parseDateTimeDetailed)(value, options)?.date ?? null;
exports.parseDateTime = parseDateTime;
const addMonths = (year, month, delta) => {
    const zeroBased = month - 1 + delta;
    const nextYear = year + Math.floor(zeroBased / 12);
    const nextMonth = ((zeroBased % 12) + 12) % 12;
    return { year: nextYear, month: nextMonth + 1 };
};
const parseDateRange = (value, options = {}) => {
    const parsed = (0, exports.parseDateTimeDetailed)(value, options);
    if (!parsed || !parsed.timeZone) {
        return null;
    }
    const timeZone = parsed.timeZone;
    const naive = parseNaiveDateTimeString(parsed.source);
    if (!naive) {
        return null;
    }
    const { year, month } = naive.parts;
    if (naive.precision === DatePrecision.Month) {
        const end = addMonths(year, month, 1);
        return {
            start: zonedTimeToUtc({ year, month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone),
            endExclusive: zonedTimeToUtc({ year: end.year, month: end.month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone),
            precision: DatePrecision.Month,
            timeZone,
            source: parsed.source,
        };
    }
    if (naive.precision === DatePrecision.Quarter) {
        const end = addMonths(year, month, 3);
        return {
            start: zonedTimeToUtc({ year, month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone),
            endExclusive: zonedTimeToUtc({ year: end.year, month: end.month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone),
            precision: DatePrecision.Quarter,
            timeZone,
            source: parsed.source,
        };
    }
    if (naive.precision === DatePrecision.Year) {
        return {
            start: zonedTimeToUtc({ year, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone),
            endExclusive: zonedTimeToUtc({ year: year + 1, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone),
            precision: DatePrecision.Year,
            timeZone,
            source: parsed.source,
        };
    }
    return null;
};
exports.parseDateRange = parseDateRange;
//# sourceMappingURL=date.js.map