import { IsInt, IsOptional, Max, Min } from "class-validator";

export class UpdateMultiTenantSchedulerSettingsDto {
  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(16)
  realtimeSignalsOrgConcurrency?: number;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(16)
  newsEventsTimelineOrgConcurrency?: number;

  @IsInt()
  @Min(1)
  @Max(16)
  newsEventsIngestionOrgConcurrency!: number;

  @IsInt()
  @Min(1)
  @Max(16)
  knowledgeGraphIngestionOrgConcurrency!: number;

  @IsInt()
  @Min(1)
  @Max(16)
  sentimentSnapshotOrgConcurrency!: number;

  @IsInt()
  @Min(1)
  @Max(16)
  newsnowHottestAnalysisOrgConcurrency!: number;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(16)
  classificationQualityAlertOrgConcurrency?: number;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(16)
  newsIndicatorAssociationOrgConcurrency?: number;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(16)
  crawlQualityTaskSnapshotOrgConcurrency?: number;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(16)
  situationMonitorOrefDefaultRuleOrgConcurrency?: number;

  @IsInt()
  @Min(1)
  @Max(16)
  userDigestDeliveryOrgConcurrency!: number;
}
