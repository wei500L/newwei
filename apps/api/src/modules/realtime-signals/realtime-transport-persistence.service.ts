import {
  MapTransportObjectStateModel,
  MapTransportTrackPointModel,
} from "@modular/mongo";
import { Injectable } from "@nestjs/common";

import {
  isValidCoordinate,
  normalizeString,
  parseTimestampMs,
} from "./realtime-signals.helpers";
import type {
  RealtimeAdsbAircraftSnapshot,
  RealtimeAisLatestSnapshot,
  RealtimeAisVesselSnapshot,
  TransportTelemetryRecord,
} from "./realtime-signals.types";
import {
  classifyAircraftTransport,
  classifyAisShipType,
} from "./transport-classification";

const MAP_TRANSPORT_GEO_CELL_STEP_DEG = 0.5;

const MAP_TRANSPORT_HEARTBEAT_MS = 10 * 60 * 1_000;

const MAP_TRANSPORT_DISTANCE_THRESHOLD_KM = 2;

const MAP_TRANSPORT_ANGLE_THRESHOLD_DEG = 15;

const MAP_TRANSPORT_SPEED_THRESHOLD_KT = 5;

const MAP_TRANSPORT_ALTITUDE_THRESHOLD_FT = 1_000;

@Injectable()
export class RealtimeTransportPersistenceService {
  async persistAircraftTransportSnapshot(
    orgId: string,
    aircraft: RealtimeAdsbAircraftSnapshot[],
    sourceUpdatedAt: string,
    sourceScope: "military" | "all",
  ) {
    const records = aircraft
      .map((entry) =>
        this.buildAircraftTransportRecord(
          orgId,
          entry,
          sourceUpdatedAt,
          sourceScope,
        ),
      )
      .filter((entry): entry is TransportTelemetryRecord => Boolean(entry));
    await this.persistTransportTelemetry(records);
  }

  private buildAircraftTransportRecord(
    orgId: string,
    aircraft: RealtimeAdsbAircraftSnapshot,
    sourceUpdatedAt: string,
    sourceScope: "military" | "all",
  ): TransportTelemetryRecord | null {
    if (!isValidCoordinate(aircraft.lat, aircraft.lng)) {
      return null;
    }
    const classification = classifyAircraftTransport({
      callsign: aircraft.callsign,
      icao24: aircraft.icao24,
      sourceScope,
    });
    const icao24 = aircraft.icao24.toLowerCase();
    return {
      orgId,
      entityKind: "aircraft",
      sourceType: "opensky",
      sourceScope,
      objectKey: `opensky:${icao24}`,
      observedAt: aircraft.observedAt,
      sourceUpdatedAt,
      lat: aircraft.lat,
      lng: aircraft.lng,
      geoCell: this.buildTransportGeoCell(aircraft.lat, aircraft.lng),
      icao24,
      ...(aircraft.callsign ? { callsign: aircraft.callsign } : {}),
      ...(aircraft.registration ? { registration: aircraft.registration } : {}),
      ...(aircraft.aircraftType ? { aircraftType: aircraft.aircraftType } : {}),
      name:
        aircraft.callsign ??
        aircraft.registration ??
        aircraft.icao24.toUpperCase(),
      ...(aircraft.countryCode ? { countryCode: aircraft.countryCode } : {}),
      ...(aircraft.countryName ? { countryName: aircraft.countryName } : {}),
      ...(typeof aircraft.heading === "number"
        ? { heading: this.normalizeHeading(aircraft.heading) }
        : {}),
      ...(typeof aircraft.groundSpeedKt === "number"
        ? { speed: aircraft.groundSpeedKt }
        : {}),
      ...(typeof aircraft.altitudeFt === "number"
        ? { altitudeFt: aircraft.altitudeFt }
        : {}),
      displayCategory: classification.displayCategory,
      displayCategoryZh: classification.displayCategoryZh,
      role: classification.role,
      roleZh: classification.roleZh,
      isMilitaryCandidate: classification.isMilitaryCandidate,
      metadata: {
        source: "opensky",
      },
    };
  }

  async persistAisTransportSnapshot(
    orgId: string,
    snapshot: RealtimeAisLatestSnapshot,
  ) {
    const merged = new Map<
      string,
      {
        vessel: RealtimeAisVesselSnapshot;
        sourceScope: "all" | "candidate";
        isMilitaryCandidate: boolean;
      }
    >();

    for (const vessel of snapshot.vessels) {
      merged.set(vessel.mmsi, {
        vessel,
        sourceScope: "all",
        isMilitaryCandidate: false,
      });
    }

    for (const vessel of snapshot.candidateReports) {
      const current = merged.get(vessel.mmsi);
      merged.set(vessel.mmsi, {
        vessel: this.mergeAisVesselSnapshot(current?.vessel, vessel),
        sourceScope: "candidate",
        isMilitaryCandidate: true,
      });
    }

    const records = Array.from(merged.values())
      .map(({ vessel, sourceScope, isMilitaryCandidate }) =>
        this.buildAisTransportRecord(
          orgId,
          vessel,
          snapshot.updatedAt,
          sourceScope,
          isMilitaryCandidate,
        ),
      )
      .filter((entry): entry is TransportTelemetryRecord => Boolean(entry));

    await this.persistTransportTelemetry(records);
  }

  private mergeAisVesselSnapshot(
    current: RealtimeAisVesselSnapshot | undefined,
    candidate: RealtimeAisVesselSnapshot,
  ): RealtimeAisVesselSnapshot {
    if (!current) {
      return candidate;
    }
    const currentObservedMs = parseTimestampMs(current.observedAt) ?? 0;
    const candidateObservedMs = parseTimestampMs(candidate.observedAt) ?? 0;
    if (candidateObservedMs >= currentObservedMs) {
      return {
        ...current,
        ...candidate,
      };
    }
    return {
      ...candidate,
      ...current,
    };
  }

  private buildAisTransportRecord(
    orgId: string,
    vessel: RealtimeAisVesselSnapshot,
    sourceUpdatedAt: string,
    sourceScope: "all" | "candidate",
    isMilitaryCandidate: boolean,
  ): TransportTelemetryRecord | null {
    if (!isValidCoordinate(vessel.lat, vessel.lng)) {
      return null;
    }
    const classification = classifyAisShipType(
      vessel.shipType,
      isMilitaryCandidate,
    );
    return {
      orgId,
      entityKind: "vessel",
      sourceType: "ais",
      sourceScope,
      objectKey: `ais:${vessel.mmsi}`,
      observedAt: vessel.observedAt,
      sourceUpdatedAt,
      lat: vessel.lat,
      lng: vessel.lng,
      geoCell: this.buildTransportGeoCell(vessel.lat, vessel.lng),
      mmsi: vessel.mmsi,
      ...(vessel.name ? { name: vessel.name } : {}),
      ...(typeof vessel.shipType === "number"
        ? { shipType: vessel.shipType }
        : {}),
      ...(typeof vessel.heading === "number"
        ? { heading: this.normalizeHeading(vessel.heading) }
        : {}),
      ...(typeof vessel.course === "number"
        ? { course: this.normalizeHeading(vessel.course) }
        : {}),
      ...(typeof vessel.speed === "number" ? { speed: vessel.speed } : {}),
      shipTypeLabel: classification.shipTypeLabel,
      shipTypeLabelZh: classification.shipTypeLabelZh,
      role: classification.vesselRole,
      roleZh: classification.vesselRoleZh,
      displayCategory: classification.shipTypeLabel,
      displayCategoryZh: classification.shipTypeLabelZh,
      isMilitaryCandidate: classification.isMilitaryCandidate,
      metadata: {
        source: "ais",
      },
    };
  }

  private async persistTransportTelemetry(records: TransportTelemetryRecord[]) {
    if (records.length === 0) {
      return;
    }

    const dedupedRecords = this.dedupeTransportTelemetryRecords(records);
    if (dedupedRecords.length === 0) {
      return;
    }

    const orgId = dedupedRecords[0]!.orgId;
    const existingStates = await MapTransportObjectStateModel.find({
      orgId,
      objectKey: { $in: dedupedRecords.map((record) => record.objectKey) },
    }).lean();
    const existingByKey = new Map<string, Record<string, unknown>>(
      existingStates.map((state) => [
        String(state.objectKey),
        state as unknown as Record<string, unknown>,
      ]),
    );

    const trackPointsToInsert: TransportTelemetryRecord[] = [];
    const statesToUpsert: {
      record: TransportTelemetryRecord;
      existing: Record<string, unknown> | null;
    }[] = [];

    for (const record of dedupedRecords) {
      const existing =
        (existingByKey.get(record.objectKey) as
          | Record<string, unknown>
          | undefined) ?? null;
      if (this.shouldPersistTransportTrackPoint(record, existing)) {
        trackPointsToInsert.push(record);
      }

      const existingObservedAtMs = this.readDateMs(existing?.observedAt);
      const recordObservedAtMs = this.readDateMs(record.observedAt);
      if (
        recordObservedAtMs !== null &&
        (existingObservedAtMs === null ||
          recordObservedAtMs >= existingObservedAtMs)
      ) {
        statesToUpsert.push({ record, existing });
        existingByKey.set(record.objectKey, {
          ...existing,
          ...record,
          observedAt: new Date(record.observedAt),
          ...(record.sourceUpdatedAt
            ? { sourceUpdatedAt: new Date(record.sourceUpdatedAt) }
            : {}),
        });
      }
    }

    const insertedTrackPointIdByObjectKey = new Map<string, unknown>();
    if (trackPointsToInsert.length > 0) {
      const inserted = await MapTransportTrackPointModel.insertMany(
        trackPointsToInsert.map((record) => this.toTransportDocument(record)),
        { ordered: false },
      );
      for (const doc of inserted) {
        const objectKey = normalizeString(doc.objectKey);
        if (objectKey) {
          insertedTrackPointIdByObjectKey.set(objectKey, doc._id);
        }
      }
    }

    if (statesToUpsert.length > 0) {
      await MapTransportObjectStateModel.bulkWrite(
        statesToUpsert.map(({ record, existing }) => {
          const latestTrackPointId =
            insertedTrackPointIdByObjectKey.get(record.objectKey) ??
            existing?.latestTrackPointId ??
            null;
          return {
            updateOne: {
              filter: {
                orgId: record.orgId,
                objectKey: record.objectKey,
              },
              update: {
                $set: {
                  ...this.toTransportDocument(record),
                  latestTrackPointId,
                },
              },
              upsert: true,
            },
          };
        }),
        { ordered: false },
      );
    }
  }

  private dedupeTransportTelemetryRecords(records: TransportTelemetryRecord[]) {
    const deduped = new Map<string, TransportTelemetryRecord>();
    for (const record of records) {
      const current = deduped.get(record.objectKey);
      if (!current) {
        deduped.set(record.objectKey, record);
        continue;
      }
      const currentObservedAtMs = this.readDateMs(current.observedAt) ?? 0;
      const candidateObservedAtMs = this.readDateMs(record.observedAt) ?? 0;
      if (candidateObservedAtMs > currentObservedAtMs) {
        deduped.set(record.objectKey, record);
        continue;
      }
      if (candidateObservedAtMs < currentObservedAtMs) {
        continue;
      }
      if (
        this.scoreTransportTelemetryRecord(record) >=
        this.scoreTransportTelemetryRecord(current)
      ) {
        deduped.set(record.objectKey, record);
      }
    }
    return Array.from(deduped.values());
  }

  private scoreTransportTelemetryRecord(record: TransportTelemetryRecord) {
    let score = 0;
    if (record.callsign) score += 1;
    if (record.registration) score += 1;
    if (record.name) score += 1;
    if (record.countryCode) score += 1;
    if (typeof record.heading === "number") score += 1;
    if (typeof record.course === "number") score += 1;
    if (typeof record.speed === "number") score += 1;
    if (typeof record.altitudeFt === "number") score += 1;
    if (typeof record.shipType === "number") score += 1;
    return score;
  }

  private shouldPersistTransportTrackPoint(
    record: TransportTelemetryRecord,
    existing: Record<string, unknown> | null,
  ) {
    if (!existing) {
      return true;
    }

    const existingObservedAtMs = this.readDateMs(existing.observedAt);
    const recordObservedAtMs = this.readDateMs(record.observedAt);
    if (recordObservedAtMs === null) {
      return false;
    }
    if (
      existingObservedAtMs !== null &&
      recordObservedAtMs <= existingObservedAtMs
    ) {
      return false;
    }

    const distanceKm = this.computeTransportDistanceKm(
      record.lat,
      record.lng,
      this.readFiniteNumber(existing.lat),
      this.readFiniteNumber(existing.lng),
    );
    if (
      typeof distanceKm === "number" &&
      distanceKm >= MAP_TRANSPORT_DISTANCE_THRESHOLD_KM
    ) {
      return true;
    }

    if (
      this.computeTransportAngleDelta(
        record.heading,
        this.readFiniteNumber(existing.heading),
      ) >= MAP_TRANSPORT_ANGLE_THRESHOLD_DEG
    ) {
      return true;
    }
    if (
      this.computeTransportAngleDelta(
        record.course,
        this.readFiniteNumber(existing.course),
      ) >= MAP_TRANSPORT_ANGLE_THRESHOLD_DEG
    ) {
      return true;
    }

    const existingSpeed = this.readFiniteNumber(existing.speed);
    if (
      typeof record.speed === "number" &&
      typeof existingSpeed === "number" &&
      Math.abs(record.speed - existingSpeed) >= MAP_TRANSPORT_SPEED_THRESHOLD_KT
    ) {
      return true;
    }

    const existingAltitudeFt = this.readFiniteNumber(existing.altitudeFt);
    if (
      record.entityKind === "aircraft" &&
      typeof record.altitudeFt === "number" &&
      typeof existingAltitudeFt === "number" &&
      Math.abs(record.altitudeFt - existingAltitudeFt) >=
        MAP_TRANSPORT_ALTITUDE_THRESHOLD_FT
    ) {
      return true;
    }

    return (
      existingObservedAtMs === null ||
      recordObservedAtMs - existingObservedAtMs >= MAP_TRANSPORT_HEARTBEAT_MS
    );
  }

  private toTransportDocument(record: TransportTelemetryRecord) {
    return {
      orgId: record.orgId,
      entityKind: record.entityKind,
      sourceType: record.sourceType,
      sourceScope: record.sourceScope,
      objectKey: record.objectKey,
      observedAt: new Date(record.observedAt),
      sourceUpdatedAt: record.sourceUpdatedAt
        ? new Date(record.sourceUpdatedAt)
        : null,
      lat: record.lat,
      lng: record.lng,
      geoCell: record.geoCell,
      icao24: record.icao24 ?? null,
      mmsi: record.mmsi ?? null,
      callsign: record.callsign ?? null,
      registration: record.registration ?? null,
      name: record.name ?? null,
      aircraftType: record.aircraftType ?? null,
      displayCategory: record.displayCategory ?? null,
      displayCategoryZh: record.displayCategoryZh ?? null,
      role: record.role ?? null,
      roleZh: record.roleZh ?? null,
      countryCode: record.countryCode ?? null,
      countryName: record.countryName ?? null,
      heading: record.heading ?? null,
      course: record.course ?? null,
      speed: record.speed ?? null,
      altitudeFt: record.altitudeFt ?? null,
      shipType: record.shipType ?? null,
      shipTypeLabel: record.shipTypeLabel ?? null,
      shipTypeLabelZh: record.shipTypeLabelZh ?? null,
      isMilitaryCandidate: record.isMilitaryCandidate,
      metadata: record.metadata ?? null,
    };
  }

  private buildTransportGeoCell(lat: number, lng: number) {
    const step = MAP_TRANSPORT_GEO_CELL_STEP_DEG;
    const latCell = Math.floor(lat / step) * step;
    const lngCell = Math.floor(lng / step) * step;
    return `${latCell.toFixed(1)},${lngCell.toFixed(1)}`;
  }

  private normalizeHeading(value: number) {
    const normalized = value % 360;
    return normalized < 0 ? normalized + 360 : normalized;
  }

  private computeTransportAngleDelta(
    left: number | null | undefined,
    right: number | null | undefined,
  ) {
    if (
      typeof left !== "number" ||
      !Number.isFinite(left) ||
      typeof right !== "number" ||
      !Number.isFinite(right)
    ) {
      return 0;
    }
    const delta = Math.abs(
      this.normalizeHeading(left) - this.normalizeHeading(right),
    );
    return Math.min(delta, 360 - delta);
  }

  private computeTransportDistanceKm(
    lat: number,
    lng: number,
    previousLat: number | null,
    previousLng: number | null,
  ) {
    if (
      previousLat === null ||
      previousLng === null ||
      !isValidCoordinate(previousLat, previousLng)
    ) {
      return null;
    }
    const toRadians = (value: number) => (value * Math.PI) / 180;
    const earthRadiusKm = 6_371;
    const dLat = toRadians(previousLat - lat);
    const dLng = toRadians(previousLng - lng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(lat)) *
        Math.cos(toRadians(previousLat)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
  }

  private readDateMs(value: unknown) {
    if (value instanceof Date) {
      const timestamp = value.getTime();
      return Number.isFinite(timestamp) ? timestamp : null;
    }
    if (typeof value === "string") {
      return parseTimestampMs(value);
    }
    return null;
  }

  private readFiniteNumber(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
}
