import { BadRequestException, Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import {
  ClassificationBatchReviewDecisionBodyDto,
  ClassificationCreateReportBodyDto,
  ClassificationReportJobParamDto,
  ClassificationReviewDecisionBodyDto,
  ClassificationReviewParamDto,
  ClassificationReviewQueueQueryDto,
  ClassificationSamplingAnnotationsBodyDto,
  ClassificationSamplingQueryBodyDto,
  ClassificationSourceItemsParamDto,
  ClassificationSourceItemsQueryDto,
  ClassificationSummaryQueryDto,
} from "./classification-quality.dto";
import { ClassificationQualityService } from "./classification-quality.service";

@ApiTags("observability")
@ApiBearerAuth()
@Controller("admin/quality/classification")
export class ClassificationQualityController {
  constructor(private readonly classificationQuality: ClassificationQualityService) {}

  @Get("summary")
  @Permissions("settings.manage")
  async summary(@CurrentUser() user: AuthenticatedUser, @Query() query: ClassificationSummaryQueryDto) {
    return this.classificationQuality.getSummary({
      orgId: user.orgId,
      window: query.window ?? "24h",
      sourceId: query.sourceId,
      categoryPrefix: query.categoryPrefix,
    });
  }

  @Get("sources/:sourceId/items")
  @Permissions("settings.manage")
  async sourceItems(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ClassificationSourceItemsParamDto,
    @Query() query: ClassificationSourceItemsQueryDto,
  ) {
    return this.classificationQuality.getLowConfidenceSourceItems({
      orgId: user.orgId,
      sourceId: params.sourceId,
      window: query.window ?? "24h",
      maxConfidence: query.maxConfidence,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  @Get("reviews/queue")
  @Permissions("settings.manage")
  async reviewQueue(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ClassificationReviewQueueQueryDto,
  ) {
    return this.classificationQuality.listReviewQueue({
      orgId: user.orgId,
      actorId: user.id,
      window: query.window ?? "24h",
      onlyUnreviewed: query.onlyUnreviewed ?? true,
      limit: query.limit,
      maxConfidence: query.maxConfidence,
    });
  }

  @Post("reviews/:reviewId/decision")
  @Permissions("settings.manage")
  async reviewDecision(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ClassificationReviewParamDto,
    @Body() body: ClassificationReviewDecisionBodyDto,
  ) {
    if (body.status === "corrected" && !body.correctedCategoryPath) {
      throw new BadRequestException("correctedCategoryPath is required when status=corrected");
    }

    return this.classificationQuality.submitReviewDecision({
      orgId: user.orgId,
      actorId: user.id,
      reviewId: params.reviewId,
      status: body.status,
      correctedCategoryPath: body.correctedCategoryPath,
      note: body.note,
      quickTags: body.quickTags,
    });
  }

  @Post("reviews/batch")
  @Permissions("settings.manage")
  async batchReviewDecision(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ClassificationBatchReviewDecisionBodyDto,
  ) {
    if (body.status === "corrected" && !body.correctedCategoryPath) {
      throw new BadRequestException("correctedCategoryPath is required when status=corrected");
    }

    return this.classificationQuality.batchReviewDecision({
      orgId: user.orgId,
      actorId: user.id,
      reviewIds: body.reviewIds,
      status: body.status,
      correctedCategoryPath: body.correctedCategoryPath,
      note: body.note,
      quickTags: body.quickTags,
    });
  }

  @Post("sampling/query")
  @Permissions("settings.manage")
  async createSample(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ClassificationSamplingQueryBodyDto,
  ) {
    return this.classificationQuality.createSample({
      orgId: user.orgId,
      actorId: user.id,
      window: body.window ?? "24h",
      sourceType: body.sourceType,
      categoryPrefix: body.categoryPrefix,
      sourceIds: body.sourceIds,
      confidenceBands: body.confidenceBands,
      methods: body.methods,
      perStratum: body.perStratum,
    });
  }

  @Post("sampling/annotations")
  @Permissions("settings.manage")
  async submitAnnotations(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ClassificationSamplingAnnotationsBodyDto,
  ) {
    return this.classificationQuality.submitAnnotations({
      orgId: user.orgId,
      actorId: user.id,
      sampleId: body.sampleId,
      annotations: body.annotations.map((entry) => ({
        processedItemId: entry.processedItemId,
        humanCategoryPath: entry.humanCategoryPath,
        note: entry.note,
        quickTags: entry.quickTags,
      })),
    });
  }

  @Post("reports")
  @Permissions("settings.manage")
  async createReport(@CurrentUser() user: AuthenticatedUser, @Body() body: ClassificationCreateReportBodyDto) {
    return this.classificationQuality.createReportJob({
      orgId: user.orgId,
      actorId: user.id,
      sampleId: body.sampleId ?? null,
    });
  }

  @Get("reports/:jobId")
  @Permissions("settings.manage")
  async reportJob(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ClassificationReportJobParamDto,
  ) {
    return this.classificationQuality.getReportJob({
      orgId: user.orgId,
      jobId: params.jobId,
    });
  }
}
