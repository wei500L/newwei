import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

class RealtimeSignalRateLimitDetailsDto {
  @ApiPropertyOptional()
  retryAfterSec?: number;

  @ApiPropertyOptional()
  rateLimit?: string;

  @ApiPropertyOptional()
  rateLimitPolicy?: string;

  @ApiPropertyOptional()
  cfRay?: string;
}

class RealtimeOpenskyRuntimeDiagnosticsDto {
  @ApiProperty({
    enum: ["fresh", "stale", "missing"],
  })
  freshness!: "fresh" | "stale" | "missing";

  @ApiProperty()
  rawAircraftCount!: number;

  @ApiProperty()
  currentValidPositionCount!: number;

  @ApiProperty()
  snapshotValidPositionCount!: number;

  @ApiPropertyOptional()
  snapshotUpdatedAt?: string;

  @ApiPropertyOptional()
  snapshotAgeSec?: number;

  @ApiPropertyOptional()
  latestObservedAt?: string;

  @ApiPropertyOptional()
  latestObservedAgeSec?: number;

  @ApiProperty()
  staleThresholdSec!: number;

  @ApiProperty()
  retainedPreviousSnapshot!: boolean;

  @ApiProperty()
  droppedInvalidPositionCount!: number;

  @ApiProperty()
  droppedMissingIdentityCount!: number;

  @ApiProperty()
  droppedStalePositionCount!: number;

  @ApiProperty()
  deduplicatedCount!: number;
}

class RealtimeSignalsInsightKeywordSpikeDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  term!: string;

  @ApiProperty()
  count!: number;

  @ApiProperty()
  baseline!: number;

  @ApiProperty()
  multiplier!: number;

  @ApiProperty()
  sourceCount!: number;

  @ApiProperty()
  confidence!: number;
}

class RealtimeSignalsInsightPredictionLeadDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  shift!: number;

  @ApiProperty()
  newsActivity!: number;

  @ApiProperty()
  confidence!: number;
}

class RealtimeSignalsInsightPizzintDto {
  @ApiProperty()
  defcon!: number;

  @ApiProperty()
  adjustedScore!: number;

  @ApiProperty()
  openLocations!: number;

  @ApiProperty()
  activeSpikes!: number;

  @ApiProperty()
  avgPop!: number;

  @ApiProperty()
  updatedAt!: string;
}

class RealtimeSignalsInsightTensionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty()
  score!: number;

  @ApiProperty()
  changePercent!: number;

  @ApiProperty({
    enum: ["rising", "stable", "falling"],
  })
  trend!: "rising" | "stable" | "falling";

  @ApiProperty({
    type: [String],
  })
  countries!: string[];

  @ApiProperty()
  updatedAt!: string;
}

class RealtimeSignalsInsightSnapshotDto {
  @ApiProperty({
    type: () => [RealtimeSignalsInsightKeywordSpikeDto],
  })
  keywordSpikes!: RealtimeSignalsInsightKeywordSpikeDto[];

  @ApiProperty({
    type: () => [RealtimeSignalsInsightPredictionLeadDto],
  })
  predictionLeads!: RealtimeSignalsInsightPredictionLeadDto[];

  @ApiPropertyOptional({
    type: () => RealtimeSignalsInsightPizzintDto,
  })
  pizzint?: RealtimeSignalsInsightPizzintDto;

  @ApiProperty({
    type: () => [RealtimeSignalsInsightTensionDto],
  })
  tensions!: RealtimeSignalsInsightTensionDto[];
}

class RealtimeSignalsMarkerReadinessDto {
  @ApiProperty()
  windowHours!: number;

  @ApiProperty()
  recentProcessedArticles!: number;

  @ApiProperty()
  recentProcessedArticlesWithLocation!: number;

  @ApiProperty()
  recentMongoProcessedItems!: number;

  @ApiProperty()
  recentMongoProcessedItemsWithLocation!: number;

  @ApiPropertyOptional()
  latestProcessedArticleAt?: string;

  @ApiPropertyOptional()
  latestProcessedItemAt?: string;

  @ApiProperty()
  newsMarkersReady!: boolean;
}

class RealtimeOpenskyBudgetDaySummaryDto {
  @ApiProperty()
  dateHkt!: string;

  @ApiProperty()
  usedCredits!: number;

  @ApiProperty()
  requestCount!: number;

  @ApiProperty()
  militaryCredits!: number;

  @ApiProperty()
  allCredits!: number;

  @ApiProperty()
  militaryCalls!: number;

  @ApiProperty()
  allCalls!: number;

  @ApiProperty()
  errorCalls!: number;

  @ApiProperty()
  authErrorCalls!: number;

  @ApiProperty()
  rateLimitedErrorCalls!: number;

  @ApiProperty()
  serverErrorCalls!: number;

  @ApiProperty()
  timeoutErrorCalls!: number;

  @ApiProperty()
  networkErrorCalls!: number;

  @ApiProperty()
  unknownErrorCalls!: number;

  @ApiProperty()
  blockedAllModeCount!: number;

  @ApiProperty()
  skippedMilitaryCount!: number;
}

class RealtimeOpenskyBudgetSummaryDto {
  @ApiProperty()
  timezone!: string;

  @ApiProperty()
  dateHkt!: string;

  @ApiProperty()
  dailyBudget!: number;

  @ApiProperty()
  usedCredits!: number;

  @ApiProperty()
  remainingCredits!: number;

  @ApiProperty()
  usagePct!: number;

  @ApiProperty()
  remainingPct!: number;

  @ApiProperty()
  requestCount!: number;

  @ApiProperty()
  militaryCredits!: number;

  @ApiProperty()
  allCredits!: number;

  @ApiProperty()
  militaryCalls!: number;

  @ApiProperty()
  allCalls!: number;

  @ApiProperty()
  errorCalls!: number;

  @ApiProperty()
  authErrorCalls!: number;

  @ApiProperty()
  rateLimitedErrorCalls!: number;

  @ApiProperty()
  serverErrorCalls!: number;

  @ApiProperty()
  timeoutErrorCalls!: number;

  @ApiProperty()
  networkErrorCalls!: number;

  @ApiProperty()
  unknownErrorCalls!: number;

  @ApiProperty()
  blockedAllModeCount!: number;

  @ApiProperty()
  skippedMilitaryCount!: number;

  @ApiProperty({
    enum: ["day", "night"],
  })
  currentPeriod!: "day" | "night";

  @ApiProperty()
  dayIntervalSec!: number;

  @ApiProperty()
  nightIntervalSec!: number;

  @ApiProperty()
  effectiveMilitaryIntervalSec!: number;

  @ApiProperty({
    enum: ["normal", "warning", "critical", "exhausted"],
  })
  degradationLevel!: "normal" | "warning" | "critical" | "exhausted";

  @ApiProperty()
  allModeBlocked!: boolean;

  @ApiProperty()
  militaryPaused!: boolean;

  @ApiProperty()
  warningRemainingPct!: number;

  @ApiProperty()
  criticalRemainingPct!: number;

  @ApiProperty({
    type: () => [RealtimeOpenskyBudgetDaySummaryDto],
  })
  recentDays!: RealtimeOpenskyBudgetDaySummaryDto[];
}

class RealtimeSignalRuntimeSourceDiagnosticsDto {
  @ApiProperty({
    enum: [
      "opensky",
      "ais",
      "unrest",
      "outages",
      "keyword_spike",
      "pizzint",
      "gdelt_tension",
      "polymarket_leads",
    ],
  })
  source!:
    | "opensky"
    | "ais"
    | "unrest"
    | "outages"
    | "keyword_spike"
    | "pizzint"
    | "gdelt_tension"
    | "polymarket_leads";

  @ApiProperty()
  enabled!: boolean;

  @ApiProperty()
  intervalSec!: number;

  @ApiPropertyOptional()
  configuredIntervalSec?: number;

  @ApiProperty({
    enum: ["ok", "error", "stale", "not_configured", "idle"],
  })
  status!: "ok" | "error" | "stale" | "not_configured" | "idle";

  @ApiPropertyOptional()
  statusReason?: string;

  @ApiPropertyOptional()
  statusReasonCode?: string;

  @ApiPropertyOptional()
  lastRunAt?: string;

  @ApiPropertyOptional()
  lastAttemptAt?: string;

  @ApiPropertyOptional()
  nextEligibleAt?: string;

  @ApiPropertyOptional()
  lastSuccessAt?: string;

  @ApiPropertyOptional()
  lastErrorAt?: string;

  @ApiPropertyOptional()
  lastError?: string;

  @ApiPropertyOptional({
    enum: [
      "dns_resolution_failed",
      "request_timeout",
      "network_error",
      "upstream_auth_failed",
      "upstream_rate_limited",
      "upstream_server_error",
      "fetch_error",
    ],
  })
  lastErrorCode?:
    | "dns_resolution_failed"
    | "request_timeout"
    | "network_error"
    | "upstream_auth_failed"
    | "upstream_rate_limited"
    | "upstream_server_error"
    | "fetch_error";

  @ApiPropertyOptional({
    enum: ["auth", "rate_limited", "server", "timeout", "network", "unknown"],
  })
  lastErrorKind?:
    | "auth"
    | "rate_limited"
    | "server"
    | "timeout"
    | "network"
    | "unknown";

  @ApiPropertyOptional()
  lastErrorStatus?: number;

  @ApiPropertyOptional({
    type: () => RealtimeSignalRateLimitDetailsDto,
  })
  lastRateLimit?: RealtimeSignalRateLimitDetailsDto;

  @ApiProperty({
    nullable: true,
  })
  latestValue!: number | null;

  @ApiProperty({
    nullable: true,
  })
  previousValue!: number | null;

  @ApiProperty({
    nullable: true,
  })
  changePercent!: number | null;

  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
  })
  context?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: () => RealtimeOpenskyRuntimeDiagnosticsDto,
  })
  openskySnapshot?: RealtimeOpenskyRuntimeDiagnosticsDto;

  @ApiPropertyOptional({
    type: () => RealtimeOpenskyRuntimeDiagnosticsDto,
  })
  adsbSnapshot?: RealtimeOpenskyRuntimeDiagnosticsDto;
}

export class RealtimeSignalsRuntimeDiagnosticsResponseDto {
  @ApiProperty()
  checkedAt!: string;

  @ApiProperty({
    enum: ["env", "db", "unknown"],
  })
  settingsSource!: "env" | "db" | "unknown";

  @ApiProperty()
  runtimeEnabled!: boolean;

  @ApiProperty({
    type: () => [RealtimeSignalRuntimeSourceDiagnosticsDto],
  })
  sources!: RealtimeSignalRuntimeSourceDiagnosticsDto[];

  @ApiProperty({
    type: () => RealtimeSignalsInsightSnapshotDto,
  })
  insight!: RealtimeSignalsInsightSnapshotDto;

  @ApiProperty({
    type: () => RealtimeSignalsMarkerReadinessDto,
  })
  markerReadiness!: RealtimeSignalsMarkerReadinessDto;

  @ApiPropertyOptional({
    type: () => RealtimeOpenskyBudgetSummaryDto,
  })
  openskyBudget?: RealtimeOpenskyBudgetSummaryDto;
}
