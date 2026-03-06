import { Body, Controller, Get, Header, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ContentSubscriptionKind, ContentSubscriptionSource } from '@prisma/client';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.service';

import {
  BatchDeleteUserContentSubscriptionsDto,
  BatchUpsertUserContentSubscriptionsDto,
  ContentSubscriptionLimitQueryDto,
  ListContentSubscriptionCatalogDto,
  LookupContentSubscriptionCatalogDto,
  RelatedTopicsQueryDto,
} from './dto/content-subscription.dto';
import { UserContentSubscriptionsService } from './user-content-subscriptions.service';

@ApiTags('user-content-subscriptions')
@ApiBearerAuth()
@Controller('user-content-subscriptions')
export class UserContentSubscriptionsController {
  constructor(private readonly subscriptions: UserContentSubscriptionsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Permissions('items.read')
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.listUserSubscriptions(user.orgId, user.id);
  }

  @Post('batch-upsert')
  @Permissions('items.read')
  async batchUpsert(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: BatchUpsertUserContentSubscriptionsDto,
  ) {
    return this.subscriptions.batchUpsertSubscriptions(user.orgId, user.id, {
      subscriptions: (body.subscriptions ?? []).map((entry) => ({
        kind: entry.kind as ContentSubscriptionKind,
        value: entry.value,
        source: (entry.source as ContentSubscriptionSource | undefined) ?? ContentSubscriptionSource.manual,
      })),
    });
  }

  @Post('batch-delete')
  @Permissions('items.read')
  async batchDelete(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: BatchDeleteUserContentSubscriptionsDto,
  ) {
    return this.subscriptions.batchDeleteSubscriptions(user.orgId, user.id, {
      subscriptions: (body.subscriptions ?? []).map((entry) => ({
        kind: entry.kind as ContentSubscriptionKind,
        value: entry.value,
      })),
    });
  }

  @Get('catalog')
  @Header('Cache-Control', 'no-store')
  @Permissions('items.read')
  async catalog(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListContentSubscriptionCatalogDto,
  ) {
    return this.subscriptions.listCatalog(user.orgId, {
      kind: query.kind as ContentSubscriptionKind | undefined,
      query: query.query,
      taxonomyPath: query.taxonomyPath,
      limit: query.limit,
    });
  }

  @Get('recommendations')
  @Header('Cache-Control', 'no-store')
  @Permissions('items.read')
  async recommendations(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ContentSubscriptionLimitQueryDto,
  ) {
    return this.subscriptions.listRecommendations(user.orgId, user.id, query.limit);
  }

  @Post('catalog/lookup')
  @Permissions('items.read')
  async lookup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: LookupContentSubscriptionCatalogDto,
  ) {
    return this.subscriptions.lookupCatalogEntries(
      user.orgId,
      (body.entries ?? []).map((entry) => ({
        kind: entry.kind as ContentSubscriptionKind,
        value: entry.value,
      })),
    );
  }

  @Get('related-topics')
  @Header('Cache-Control', 'no-store')
  @Permissions('items.read')
  async relatedTopics(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RelatedTopicsQueryDto,
  ) {
    return this.subscriptions.listRelatedTopics(
      user.orgId,
      user.id,
      query.topic,
      query.limit,
    );
  }
}
