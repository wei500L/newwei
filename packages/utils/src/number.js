"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toPercentage = exports.formatNumber = void 0;
const formatNumber = (value, locale = "en-US") => {
    return new Intl.NumberFormat(locale).format(value);
};
exports.formatNumber = formatNumber;
const toPercentage = (value, fractionDigits = 2) => {
    return `${(value * 100).toFixed(fractionDigits)}%`;
};
exports.toPercentage = toPercentage;
//# sourceMappingURL=number.js.map