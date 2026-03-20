import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.service';

import { CrawlStrategyRuntimeService } from './crawl-strategy-runtime.service';
import { CrawlStrategyWorkflowService } from './crawl-strategy-workflow.service';
import {
  CompareCrawlStrategyWorkflowVersionsDto,
  CreateCrawlStrategyWorkflowDto,
  ListCrawlStrategyWorkflowDto,
  PublishCrawlStrategyWorkflowDto,
  TrialRunCrawlStrategyWorkflowDto,
  UpdateCrawlStrategyWorkflowDraftDto,
} from './dto/crawl-strategy.dto';

@ApiTags('crawl')
@ApiBearerAuth()
@Controller('admin/crawl-frontier')
export class CrawlStrategyController {
  constructor(
    private readonly workflows: CrawlStrategyWorkflowService,
    private readonly runtime: CrawlStrategyRuntimeService,
  ) {}

  @Get('workflows/node-schemas')
  @Permissions('crawl.read')
  async listNodeSchemas() {
    return this.workflows.listNodeSchemas();
  }

  @Get('workflows')
  @Permissions('crawl.read')
  async listWorkflows(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListCrawlStrategyWorkflowDto,
  ) {
    return this.workflows.listWorkflows(user.orgId, query);
  }

  @Post('workflows')
  @Permissions('crawl.write')
  async createWorkflow(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCrawlStrategyWorkflowDto,
  ) {
    return this.workflows.createWorkflow(user.orgId, user.id, body);
  }

  @Get('workflows/:id')
  @Permissions('crawl.read')
  async getWorkflow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.workflows.getWorkflow(user.orgId, id);
  }

  @Patch('workflows/:id/draft')
  @Permissions('crawl.write')
  async updateDraft(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateCrawlStrategyWorkflowDraftDto,
  ) {
    return this.workflows.updateDraft(user.orgId, user.id, id, body);
  }

  @Post('workflows/:id/publish')
  @Permissions('crawl.write')
  async publishWorkflow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: PublishCrawlStrategyWorkflowDto,
  ) {
    return this.workflows.publishWorkflow(user.orgId, user.id, id, body);
  }

  @Get('workflows/:id/versions')
  @Permissions('crawl.read')
  async listVersions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.workflows.listVersions(user.orgId, id);
  }

  @Get('workflow-versions/:versionId')
  @Permissions('crawl.read')
  async getVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
  ) {
    return this.workflows.getVersion(user.orgId, versionId);
  }

  @Post('workflows/compare')
  @Permissions('crawl.read')
  async compareVersions(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CompareCrawlStrategyWorkflowVersionsDto,
  ) {
    return this.workflows.compareVersions(user.orgId, body);
  }

  @Post('workflows/:id/trial-run')
  @Permissions('crawl.read')
  async trialRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: TrialRunCrawlStrategyWorkflowDto,
  ) {
    return this.runtime.trialRunWorkflow(user.orgId, user.id, id, body);
  }

  @Get('workflow-runs/:runId')
  @Permissions('crawl.read')
  async getRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
  ) {
    return this.runtime.getRun(user.orgId, runId);
  }

  @Get('workflow-runs/:runId/candidates')
  @Permissions('crawl.read')
  async listRunCandidates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
  ) {
    return this.runtime.listRunCandidates(user.orgId, runId);
  }

  @Get('workflow-runs/:runId/candidates/:candidateId/explanation')
  @Permissions('crawl.read')
  async getCandidateExplanation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
    @Param('candidateId') candidateId: string,
  ) {
    return this.runtime.getCandidateExplanation(user.orgId, runId, candidateId);
  }

  @Get('profiles/:id/workflow-bridge')
  @Permissions('crawl.read')
  async getProfileWorkflowBridge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('seedUrl') seedUrl?: string,
  ) {
    return this.workflows.buildLegacyProfileBridge(user.orgId, id, seedUrl);
  }

  @Get('news-sources/:id/workflow-bridge')
  @Permissions('crawl.read')
  async getNewsSourceWorkflowBridge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.workflows.buildLegacyNewsSourceBridge(user.orgId, id);
  }
}
