import {
  Schema,
  model,
  models,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from "mongoose";

export const DEFAULT_MAP_TRANSPORT_RETENTION_DAYS = 30;
const SECONDS_PER_DAY = 24 * 60 * 60;

const MapTransportTrackPointSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    entityKind: {
      type: String,
      enum: ["aircraft", "vessel"],
      required: true,
      index: true,
    },
    sourceType: {
      type: String,
      enum: ["opensky", "ais"],
      required: true,
      index: true,
    },
    sourceScope: {
      type: String,
      enum: ["military", "all", "candidate"],
      required: true,
      index: true,
    },
    objectKey: { type: String, required: true, index: true },
    observedAt: { type: Date, required: true, index: true },
    sourceUpdatedAt: { type: Date, default: null },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    geoCell: { type: String, required: true, index: true },
    icao24: { type: String, default: null, index: true },
    mmsi: { type: String, default: null, index: true },
    callsign: { type: String, default: null },
    registration: { type: String, default: null },
    name: { type: String, default: null },
    aircraftType: { type: String, default: null },
    displayCategory: { type: String, default: null },
    displayCategoryZh: { type: String, default: null },
    role: { type: String, default: null },
    roleZh: { type: String, default: null },
    countryCode: { type: String, default: null },
    countryName: { type: String, default: null },
    heading: { type: Number, default: null },
    course: { type: Number, default: null },
    speed: { type: Number, default: null },
    altitudeFt: { type: Number, default: null },
    shipType: { type: Number, default: null },
    shipTypeLabel: { type: String, default: null },
    shipTypeLabelZh: { type: String, default: null },
    isMilitaryCandidate: { type: Boolean, default: false },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  },
);

MapTransportTrackPointSchema.index({ orgId: 1, objectKey: 1, observedAt: -1 });
MapTransportTrackPointSchema.index({
  orgId: 1,
  entityKind: 1,
  observedAt: -1,
});
MapTransportTrackPointSchema.index({
  orgId: 1,
  geoCell: 1,
  observedAt: -1,
});
MapTransportTrackPointSchema.index({
  observedAt: 1,
}, {
  name: "map_transport_track_point_observed_at_ttl",
  expireAfterSeconds: DEFAULT_MAP_TRANSPORT_RETENTION_DAYS * SECONDS_PER_DAY,
});

const MapTransportObjectStateSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },
    entityKind: {
      type: String,
      enum: ["aircraft", "vessel"],
      required: true,
      index: true,
    },
    sourceType: {
      type: String,
      enum: ["opensky", "ais"],
      required: true,
      index: true,
    },
    sourceScope: {
      type: String,
      enum: ["military", "all", "candidate"],
      required: true,
      index: true,
    },
    objectKey: { type: String, required: true },
    latestTrackPointId: { type: Schema.Types.ObjectId, default: null },
    observedAt: { type: Date, required: true, index: true },
    sourceUpdatedAt: { type: Date, default: null },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    geoCell: { type: String, required: true, index: true },
    icao24: { type: String, default: null, index: true },
    mmsi: { type: String, default: null, index: true },
    callsign: { type: String, default: null },
    registration: { type: String, default: null },
    name: { type: String, default: null },
    aircraftType: { type: String, default: null },
    displayCategory: { type: String, default: null },
    displayCategoryZh: { type: String, default: null },
    role: { type: String, default: null },
    roleZh: { type: String, default: null },
    countryCode: { type: String, default: null },
    countryName: { type: String, default: null },
    heading: { type: Number, default: null },
    course: { type: Number, default: null },
    speed: { type: Number, default: null },
    altitudeFt: { type: Number, default: null },
    shipType: { type: Number, default: null },
    shipTypeLabel: { type: String, default: null },
    shipTypeLabelZh: { type: String, default: null },
    isMilitaryCandidate: { type: Boolean, default: false },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  },
);

MapTransportObjectStateSchema.index({ orgId: 1, objectKey: 1 }, { unique: true });
MapTransportObjectStateSchema.index({
  orgId: 1,
  entityKind: 1,
  observedAt: -1,
});
MapTransportObjectStateSchema.index({
  orgId: 1,
  geoCell: 1,
  observedAt: -1,
});

export type MapTransportTrackPoint = InferSchemaType<
  typeof MapTransportTrackPointSchema
>;
export type MapTransportObjectState = InferSchemaType<
  typeof MapTransportObjectStateSchema
>;

export const MapTransportTrackPointModel =
  (models.MapTransportTrackPoint as Model<MapTransportTrackPoint> | undefined) ||
  model<MapTransportTrackPoint>(
    "MapTransportTrackPoint",
    MapTransportTrackPointSchema,
  );

export const MapTransportObjectStateModel =
  (models.MapTransportObjectState as Model<MapTransportObjectState> | undefined) ||
  model<MapTransportObjectState>(
    "MapTransportObjectState",
    MapTransportObjectStateSchema,
  );

export type MapTransportTrackPointDocument =
  HydratedDocument<MapTransportTrackPoint>;
export type MapTransportObjectStateDocument =
  HydratedDocument<MapTransportObjectState>;
