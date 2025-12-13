"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RawItemModel = void 0;
const mongoose_1 = require("mongoose");
const toStringArray = (value) => {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => {
        if (typeof entry === "string") {
            return entry.trim();
        }
        if (typeof entry === "number") {
            return entry.toString();
        }
        return null;
    })
        .filter((entry) => Boolean(entry && entry.trim()));
};
const toOptionalTrimmedString = (value) => {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};
const toOptionalNullableTrimmedString = (value) => {
    if (value === null) {
        return null;
    }
    return toOptionalTrimmedString(value);
};
const toPlainObject = (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return {};
};
const RawItemPayloadSchema = new mongoose_1.Schema({
    url: { type: String, required: true, trim: true, minlength: 1 },
    language: {
        type: String,
        set: toOptionalTrimmedString
    },
    sourceName: {
        type: String,
        default: undefined,
        set: toOptionalNullableTrimmedString
    },
    keywords: {
        type: [String],
        default: [],
        set: toStringArray
    },
    tags: {
        type: [String],
        default: [],
        set: toStringArray
    },
    summaryHints: {
        type: [String],
        default: [],
        set: toStringArray
    },
    metadata: {
        type: mongoose_1.Schema.Types.Mixed,
        default: {},
        set: toPlainObject
    },
    crawlOptions: {
        type: mongoose_1.Schema.Types.Mixed,
        set: (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : undefined)
    },
    forceRefresh: {
        type: Boolean,
        default: false,
        set: (value) => Boolean(value)
    }
}, {
    _id: false,
    id: false,
    minimize: false
});
const RawItemSchema = new mongoose_1.Schema({
    itemMetaId: { type: String, index: true, required: true, trim: true },
    payload: { type: RawItemPayloadSchema, required: true },
    source: { type: String, default: "manual" }
}, {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
});
exports.RawItemModel = mongoose_1.models.RawItem || (0, mongoose_1.model)("RawItem", RawItemSchema);
//# sourceMappingURL=raw-item.js.map