import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

const toStringArray = (value: unknown): string[] => {
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
    .filter((entry): entry is string => Boolean(entry && entry.trim()));
};

const toOptionalTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toOptionalNullableTrimmedString = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }
  return toOptionalTrimmedString(value);
};

const toPlainObject = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

const RawItemPayloadSchema = new Schema(
  {
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
      type: Schema.Types.Mixed,
      default: {},
      set: toPlainObject
    },
    crawlOptions: {
      type: Schema.Types.Mixed,
      set: (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value : undefined)
    },
    forceRefresh: {
      type: Boolean,
      default: false,
      set: (value: unknown) => Boolean(value)
    }
  },
  {
    _id: false,
    id: false,
    minimize: false
  }
);

const RawItemSchema = new Schema(
  {
    itemMetaId: { type: String, index: true, required: true, trim: true },
    payload: { type: RawItemPayloadSchema, required: true },
    source: { type: String, default: "manual" }
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
  }
);

export type RawItem = InferSchemaType<typeof RawItemSchema>;

export const RawItemModel =
  (models.RawItem as Model<RawItem> | undefined) || model<RawItem>("RawItem", RawItemSchema);

export type RawItemDocument = HydratedDocument<RawItem>;
