import { Args, Context, Int, Mutation, Query, Resolver } from "@nestjs/graphql";
import { AllowAuthenticated } from "../../common/decorators/allow-authenticated.decorator";
import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { NotificationsService } from "../../modules/notifications/notifications.service";
import { NotificationModel } from "../models/notification.model";
import { AuthenticatedUser } from "../../modules/auth/auth.service";
import { ForbiddenException, UseGuards } from "@nestjs/common";
import { NotificationEvent } from "../../modules/notifications/notification.dispatcher";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class NotificationResolver {
  constructor(private readonly notifications: NotificationsService) {}

  @AllowAuthenticated()
  @Query(() => [NotificationModel])
  async notifications(
    @Context("req") req: any,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<NotificationModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const take = Math.min(limit ?? 20, 50);
    const results = await this.notifications.listForUser(requester.orgId, requester.id, take);
    return results.map((notification) => this.toModel(notification));
  }

  @AllowAuthenticated()
  @Query(() => Int)
  async unreadNotificationCount(@Context("req") req: any): Promise<number> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.notifications.countUnread(requester.orgId, requester.id);
  }

  @AllowAuthenticated()
  @Mutation(() => NotificationModel, { nullable: true })
  async markNotificationRead(
    @Context("req") req: any,
    @Args("id") id: string
  ): Promise<NotificationModel | null> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const updated = await this.notifications.markRead(requester.orgId, requester.id, id);
    return updated ? this.toModel(updated) : null;
  }

  @AllowAuthenticated()
  @Mutation(() => Boolean)
  async markAllNotificationsRead(@Context("req") req: any): Promise<boolean> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const count = await this.notifications.markAllRead(requester.orgId, requester.id);
    return count > 0;
  }

  private toModel(event: NotificationEvent): NotificationModel {
    return {
      id: event.id,
      type: event.type,
      title: event.title,
      body: event.body ?? undefined,
      data: event.data ?? undefined,
      createdAt: new Date(event.createdAt),
      readAt: event.readAt ? new Date(event.readAt) : null
    };
  }
}
