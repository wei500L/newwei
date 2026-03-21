import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { CrawlFrontierService } from "./crawl-frontier.service";
import { CrawlSiteProfileService } from "./crawl-site-profile.service";
import {
  BulkCrawlFrontierIdsDto,
  CreateCrawlFrontierRunDto,
  CreateCrawlSiteProfileDto,
  ListCrawlFrontierRunDto,
  ListCrawlSiteProfileDto,
  MatchCrawlSiteProfileDto,
  PreviewCrawlSiteProfileDto,
  UpdateCrawlSiteProfileDto,
} from "./dto/crawl-frontier.dto";

@ApiTags("crawl")
@ApiBearerAuth()
@Controller("admin/crawl-frontier")
export class CrawlFrontierController {
  constructor(
    private readonly profiles: CrawlSiteProfileService,
    private readonly frontier: CrawlFrontierService,
  ) {}

  @Get("profiles")
  @Permissions("crawl.read")
  async listProfiles(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListCrawlSiteProfileDto,
  ) {
    return this.profiles.listProfiles(user.orgId, query);
  }

  @Get("profiles/match")
  @Permissions("crawl.read")
  async matchProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MatchCrawlSiteProfileDto,
  ) {
    return this.profiles.matchProfileForUrl(user.orgId, query.url);
  }

  @Post("profiles/preview")
  @Permissions("crawl.read")
  async previewProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PreviewCrawlSiteProfileDto,
  ) {
    return this.profiles.previewProfileDraft(user.orgId, body);
  }

  @Get("profiles/:id")
  @Permissions("crawl.read")
  async getProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.profiles.getProfile(user.orgId, id);
  }

  @Post("profiles")
  @Permissions("crawl.write")
  async createProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCrawlSiteProfileDto,
  ) {
    return this.profiles.createProfile(user.orgId, user.id, body);
  }

  @Patch("profiles/:id")
  @Permissions("crawl.write")
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: UpdateCrawlSiteProfileDto,
  ) {
    return this.profiles.updateProfile(user.orgId, user.id, id, body);
  }

  @Get("profiles/:id/versions")
  @Permissions("crawl.read")
  async listVersions(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.profiles.listVersions(user.orgId, id);
  }

  @Post("profiles/:id/rollback/:version")
  @Permissions("crawl.write")
  async rollbackProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Param("version") version: string,
  ) {
    return this.profiles.rollbackProfile(
      user.orgId,
      user.id,
      id,
      Number.parseInt(version, 10),
    );
  }

  @Get("runs")
  @Permissions("crawl.read")
  async listRuns(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListCrawlFrontierRunDto,
  ) {
    return this.frontier.listRuns(user.orgId, query);
  }

  @Post("runs")
  @Permissions("crawl.write")
  async createRun(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCrawlFrontierRunDto,
  ) {
    return this.frontier.createRun(user.orgId, user.id, body);
  }

  @Get("runs/:id")
  @Permissions("crawl.read")
  async getRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.frontier.getRun(user.orgId, id);
  }

  @Get("runs/:id/workflow-run")
  @Permissions("crawl.read")
  async getRunWorkflowRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.frontier.getRunWorkflowRun(user.orgId, id);
  }

  @Get("runs/:id/workflow-candidates")
  @Permissions("crawl.read")
  async listRunWorkflowCandidates(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.frontier.listRunWorkflowCandidates(user.orgId, id);
  }

  @Get("runs/:id/workflow-candidates/:candidateId")
  @Permissions("crawl.read")
  async getRunWorkflowCandidateExplanation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Param("candidateId") candidateId: string,
  ) {
    return this.frontier.getRunWorkflowCandidateExplanation(
      user.orgId,
      id,
      candidateId,
    );
  }

  @Post("runs/cancel")
  @Permissions("crawl.write")
  async cancelRuns(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: BulkCrawlFrontierIdsDto,
  ) {
    return this.frontier.cancelRuns(user.orgId, body.ids);
  }

  @Post("runs/:id/cancel")
  @Permissions("crawl.write")
  async cancelRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.frontier.cancelRun(user.orgId, id);
  }

  @Get("nodes/:id")
  @Permissions("crawl.read")
  async getNode(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.frontier.getNode(user.orgId, id);
  }

  @Post("nodes/retry")
  @Permissions("crawl.write")
  async retryNodes(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: BulkCrawlFrontierIdsDto,
  ) {
    return this.frontier.retryNodes(user.orgId, body.ids);
  }

  @Post("nodes/:id/retry")
  @Permissions("crawl.write")
  async retryNode(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.frontier.retryNode(user.orgId, id);
  }
}
