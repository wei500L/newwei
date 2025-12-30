import { BadRequestException, UseGuards } from '@nestjs/common';
import { Args, Context, Int, Query, Resolver } from '@nestjs/graphql';

import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { GqlPermissionsGuard } from '../../common/guards/gql-permissions.guard';
import { AuthenticatedUser } from '../../modules/auth/auth.service';
import { ItemsService } from '../../modules/items/items.service';
import { HasPermission } from '../decorators/has-permission.decorator';
import type { GqlRequest } from '../graphql.types';
import { TopicGroupModel } from '../models/topic.model';

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class TopicsResolver {
  constructor(private readonly itemsService: ItemsService) {}

  @HasPermission('items.read')
  @Query(() => [TopicGroupModel])
  async topicGroups(
    @Context('req') req: GqlRequest,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('itemsPerGroup', { type: () => Int, nullable: true }) itemsPerGroup?: number,
    @Args('windowDays', { type: () => Int, nullable: true }) windowDays?: number
  ): Promise<TopicGroupModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new BadRequestException('Unauthenticated');
    }

    const groups = await this.itemsService.listTopicGroups(requester.orgId, {
      limit,
      itemsPerGroup,
      windowDays
    });

    return groups.map((group) => ({
      topic: group.topic,
      count: group.count,
      latestAt: group.latestAt,
      items: group.items.map((item) => ({
        id: item.processedId,
        itemMetaId: item.itemMetaId,
        title: item.title ?? undefined,
        summary: item.summary ?? undefined,
        source: item.source ?? undefined,
        publishedAt: item.publishedAt ?? undefined,
        createdAt: item.createdAt
      }))
    }));
  }
}
