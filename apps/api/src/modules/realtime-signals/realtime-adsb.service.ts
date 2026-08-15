import { Injectable } from "@nestjs/common";

import {
  OpenSkyBudgetExhaustedError,
  OpenSkyBudgetReserveError,
  OPENSKY_MILITARY_QUERY_REGIONS,
  RealtimeOpenskyService,
} from "./realtime-opensky.service";
import { REALTIME_SIGNAL_METRIC_SLUGS } from "./realtime-signals.constants";
import {
  buildAdsbLatestSnapshot,
  buildAdsbRuntimeDiagnostics,
  computeAdsbSnapshotHealthValue,
  getAdsbSnapshotTtlSeconds,
  getAdsbStaleThresholdSeconds,
  resolveOpenSkyCountryCode,
  selectAdsbSnapshotToStore,
} from "./realtime-signals.helpers";
import { RealtimeSignalsSnapshotStore } from "./realtime-signals.snapshot-store";
import type {
  OpenSkyStateVector,
  RealtimeSignalFetchResult,
  RealtimeSignalsRuntimeConfig,
} from "./realtime-signals.types";
import { RealtimeTransportPersistenceService } from "./realtime-transport-persistence.service";

@Injectable()
export class RealtimeAdsbService {
  constructor(
    private readonly store: RealtimeSignalsSnapshotStore,
    private readonly opensky: RealtimeOpenskyService,
    private readonly transport: RealtimeTransportPersistenceService,
  ) {}

  async fetchAdsbSignal(orgId: string, runtime: RealtimeSignalsRuntimeConfig) {
    const endpoint = `${this.opensky.getOpenskyBaseUrl(runtime)}/states/all?regions=${OPENSKY_MILITARY_QUERY_REGIONS.map((region) => region.key).join(",")}`;
    const nowMs = Date.now();
    const budgetSummary = await this.opensky.getOpenskyBudgetSummary(
      runtime,
      nowMs,
    );
    const effectiveIntervalSec = budgetSummary.effectiveMilitaryIntervalSec;
    const budgetContext = this.opensky.buildOpenskyBudgetContext(budgetSummary);
    if (!this.opensky.hasOpenskyCredentials(runtime)) {
      await this.store.clearLatestAdsbSnapshot(orgId);
      return [
        {
          metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.opensky,
          value: 0,
          context: {
            source: "opensky",
            scope: "military",
            configured: false,
            authRequired: true,
            authMode: "oauth2_client_credentials",
            sourceEndpoint: endpoint,
            totalAircraft: 0,
            militaryCount: 0,
            validPositionCount: 0,
            snapshotValidPositionCount: 0,
            countryCodes: [],
            ...budgetContext,
          },
        },
        {
          metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.openskySnapshotHealth,
          value: 0,
          context: {
            source: "opensky",
            scope: "military",
            configured: false,
            authRequired: true,
            authMode: "oauth2_client_credentials",
            sourceEndpoint: endpoint,
            healthState: "missing",
            snapshotFreshness: "missing",
            stale: false,
            rawAircraftCount: 0,
            currentValidPositionCount: 0,
            snapshotValidPositionCount: 0,
            countryCodes: [],
            ...budgetContext,
          },
        },
      ] satisfies RealtimeSignalFetchResult[];
    }

    const previousSnapshot = await this.store.getLatestAdsbSnapshot(orgId);
    let militaryStates: OpenSkyStateVector[];
    try {
      militaryStates =
        await this.opensky.fetchConservativeMilitaryOpenSkyStates(
          runtime,
          budgetSummary,
        );
    } catch (error) {
      if (
        !(error instanceof OpenSkyBudgetExhaustedError) &&
        !(error instanceof OpenSkyBudgetReserveError)
      ) {
        throw error;
      }

      const pausedSnapshot = previousSnapshot;
      const adsbSnapshot = buildAdsbRuntimeDiagnostics(
        pausedSnapshot,
        {
          rawAircraftCount: pausedSnapshot?.totalAircraft ?? 0,
          currentValidPositionCount: pausedSnapshot?.validPositionCount ?? 0,
        },
        nowMs,
        effectiveIntervalSec,
      );
      const countryCodes = Array.from(
        new Set(
          (pausedSnapshot?.aircraft ?? [])
            .map((entry) => entry.countryCode)
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort();
      const militaryCount = pausedSnapshot?.aircraft.length ?? 0;
      const budgetReserveFailureContext =
        error instanceof OpenSkyBudgetReserveError
          ? {
              budgetReservationFailed: true,
              budgetReservationFailureCode:
                "opensky_budget_insufficient_credits",
            }
          : {};

      return [
        {
          metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.opensky,
          value: militaryCount,
          context: {
            source: "opensky",
            sourceEndpoint: endpoint,
            scope: "military",
            configured: true,
            authRequired: true,
            authMode: "oauth2_client_credentials",
            totalAircraft: pausedSnapshot?.totalAircraft ?? 0,
            militaryCount,
            validPositionCount: pausedSnapshot?.validPositionCount ?? 0,
            snapshotValidPositionCount: pausedSnapshot?.validPositionCount ?? 0,
            latestObservedAt:
              pausedSnapshot?.latestObservedAt ??
              pausedSnapshot?.diagnostics.latestObservedAt ??
              pausedSnapshot?.updatedAt,
            snapshotUpdatedAt: pausedSnapshot?.updatedAt,
            snapshotFreshness: adsbSnapshot.freshness,
            snapshotAgeSec: adsbSnapshot.snapshotAgeSec,
            latestObservedAgeSec: adsbSnapshot.latestObservedAgeSec,
            snapshotRetainedPrevious:
              pausedSnapshot?.diagnostics.retainedPreviousSnapshot ?? false,
            staleThresholdSec: adsbSnapshot.staleThresholdSec,
            droppedInvalidPositionCount:
              pausedSnapshot?.diagnostics.droppedInvalidPositionCount ?? 0,
            droppedMissingIdentityCount:
              pausedSnapshot?.diagnostics.droppedMissingIdentityCount ?? 0,
            droppedStalePositionCount:
              pausedSnapshot?.diagnostics.droppedStalePositionCount ?? 0,
            deduplicatedCount:
              pausedSnapshot?.diagnostics.deduplicatedCount ?? 0,
            countryCodes,
            ...budgetContext,
            ...budgetReserveFailureContext,
          },
        },
        {
          metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.openskySnapshotHealth,
          value:
            pausedSnapshot && adsbSnapshot.freshness === "fresh"
              ? computeAdsbSnapshotHealthValue(pausedSnapshot, adsbSnapshot)
              : 2,
          context: {
            source: "opensky",
            sourceEndpoint: endpoint,
            scope: "military",
            configured: true,
            authRequired: true,
            authMode: "oauth2_client_credentials",
            healthState: adsbSnapshot.freshness,
            stale: adsbSnapshot.freshness !== "fresh",
            snapshotRetainedPrevious:
              pausedSnapshot?.diagnostics.retainedPreviousSnapshot ?? false,
            snapshotFreshness: adsbSnapshot.freshness,
            snapshotUpdatedAt: pausedSnapshot?.updatedAt,
            latestTimestamp:
              pausedSnapshot?.latestObservedAt ??
              pausedSnapshot?.diagnostics.latestObservedAt ??
              pausedSnapshot?.updatedAt,
            maxStaleMinutes: Math.max(
              1,
              Math.round(adsbSnapshot.staleThresholdSec / 60),
            ),
            rawAircraftCount: pausedSnapshot?.totalAircraft ?? 0,
            currentValidPositionCount: pausedSnapshot?.validPositionCount ?? 0,
            snapshotValidPositionCount: pausedSnapshot?.validPositionCount ?? 0,
            droppedInvalidPositionCount:
              pausedSnapshot?.diagnostics.droppedInvalidPositionCount ?? 0,
            droppedMissingIdentityCount:
              pausedSnapshot?.diagnostics.droppedMissingIdentityCount ?? 0,
            droppedStalePositionCount:
              pausedSnapshot?.diagnostics.droppedStalePositionCount ?? 0,
            deduplicatedCount:
              pausedSnapshot?.diagnostics.deduplicatedCount ?? 0,
            countryCodes,
            ...budgetContext,
            ...budgetReserveFailureContext,
          },
        },
      ] satisfies RealtimeSignalFetchResult[];
    }

    const militaryCount = militaryStates.length;
    const countries = new Set<string>();
    for (const state of militaryStates) {
      const countryCode = resolveOpenSkyCountryCode(state.countryName);
      if (countryCode) {
        countries.add(countryCode);
      }
    }
    const countryCodes = Array.from(countries).sort();

    const nextSnapshot = buildAdsbLatestSnapshot(
      endpoint,
      militaryStates.map((entry) => entry.raw),
      militaryCount,
      nowMs,
      getAdsbStaleThresholdSeconds(effectiveIntervalSec),
    );
    const latestSnapshot = selectAdsbSnapshotToStore(
      previousSnapshot,
      nextSnapshot,
      nowMs,
      effectiveIntervalSec,
    );
    await this.store.setLatestAdsbSnapshot(
      orgId,
      latestSnapshot,
      getAdsbSnapshotTtlSeconds(effectiveIntervalSec),
    );
    await this.transport.persistAircraftTransportSnapshot(
      orgId,
      nextSnapshot.aircraft,
      nextSnapshot.updatedAt,
      "military",
    );
    const adsbSnapshot = buildAdsbRuntimeDiagnostics(
      latestSnapshot,
      {
        rawAircraftCount: militaryCount,
        currentValidPositionCount: nextSnapshot.validPositionCount,
      },
      nowMs,
      effectiveIntervalSec,
    );

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.opensky,
        value: militaryCount,
        context: {
          source: "opensky",
          sourceEndpoint: endpoint,
          scope: "military",
          configured: true,
          authRequired: true,
          authMode: "oauth2_client_credentials",
          totalAircraft: militaryCount,
          militaryCount,
          validPositionCount: nextSnapshot.validPositionCount,
          snapshotValidPositionCount: latestSnapshot.validPositionCount,
          latestObservedAt:
            latestSnapshot.latestObservedAt ??
            latestSnapshot.diagnostics.latestObservedAt ??
            latestSnapshot.updatedAt,
          snapshotUpdatedAt: latestSnapshot.updatedAt,
          snapshotFreshness: adsbSnapshot.freshness,
          snapshotAgeSec: adsbSnapshot.snapshotAgeSec,
          latestObservedAgeSec: adsbSnapshot.latestObservedAgeSec,
          snapshotRetainedPrevious:
            latestSnapshot.diagnostics.retainedPreviousSnapshot,
          staleThresholdSec: latestSnapshot.diagnostics.staleThresholdSec,
          droppedInvalidPositionCount:
            nextSnapshot.diagnostics.droppedInvalidPositionCount,
          droppedMissingIdentityCount:
            nextSnapshot.diagnostics.droppedMissingIdentityCount,
          droppedStalePositionCount:
            nextSnapshot.diagnostics.droppedStalePositionCount,
          deduplicatedCount: nextSnapshot.diagnostics.deduplicatedCount,
          countryCodes,
          ...budgetContext,
        },
      },
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.openskySnapshotHealth,
        value: computeAdsbSnapshotHealthValue(latestSnapshot, adsbSnapshot),
        context: {
          source: "opensky",
          sourceEndpoint: endpoint,
          scope: "military",
          configured: true,
          authRequired: true,
          authMode: "oauth2_client_credentials",
          healthState: adsbSnapshot.freshness,
          stale: adsbSnapshot.freshness !== "fresh",
          snapshotRetainedPrevious:
            latestSnapshot.diagnostics.retainedPreviousSnapshot,
          snapshotFreshness: adsbSnapshot.freshness,
          snapshotUpdatedAt: latestSnapshot.updatedAt,
          latestTimestamp:
            latestSnapshot.latestObservedAt ??
            latestSnapshot.diagnostics.latestObservedAt ??
            latestSnapshot.updatedAt,
          maxStaleMinutes: Math.max(
            1,
            Math.round(latestSnapshot.diagnostics.staleThresholdSec / 60),
          ),
          rawAircraftCount: adsbSnapshot.rawAircraftCount,
          currentValidPositionCount: adsbSnapshot.currentValidPositionCount,
          snapshotValidPositionCount: adsbSnapshot.snapshotValidPositionCount,
          droppedInvalidPositionCount:
            latestSnapshot.diagnostics.droppedInvalidPositionCount,
          droppedMissingIdentityCount:
            latestSnapshot.diagnostics.droppedMissingIdentityCount,
          droppedStalePositionCount:
            latestSnapshot.diagnostics.droppedStalePositionCount,
          deduplicatedCount: latestSnapshot.diagnostics.deduplicatedCount,
          countryCodes,
          ...budgetContext,
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
  }
}
