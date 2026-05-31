import { IsInt, IsOptional, Max, Min } from "class-validator";

export class UpdateMultiTenantSchedulerSettingsDto {
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
  @Min(1)
  @Max(16)
  userDigestDeliveryOrgConcurrency!: number;
}
