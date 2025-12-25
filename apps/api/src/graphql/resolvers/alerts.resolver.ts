import { ForbiddenException, Inject, UseGuards } from "@nestjs/common";
import { Args, Context, Int, Mutation, Query, Resolver, Subscription } from "@nestjs/graphql";
import { PubSubEngine , withFilter } from "graphql-subscriptions";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { ALERTS_PUBSUB } from "../../modules/alerts/alerts.pubsub";
import { AlertsService } from "../../modules/alerts/alerts.service";
import { AuthenticatedUser } from "../../modules/auth/auth.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import { AlertChannelInput, UpsertAlertRuleInput } from "../dto/alert.input";
import type { GqlRequest } from "../graphql.types";
import { AlertChannelModel, AlertEventModel, AlertRuleModel } from "../models/alert.model";


@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class AlertsResolver {
  constructor(private readonly alerts: AlertsService, @Inject(ALERTS_PUBSUB) private readonly pubsub: PubSubEngine) {}

  @HasPermission("alerts.read")
  @Query(() => [AlertChannelModel])
  async alertChannels(@Context("req") req: GqlRequest): Promise<AlertChannelModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const channels = await this.alerts.listChannels(requester.orgId);
    return channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      target: channel.target,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt
    }));
  }

  @HasPermission("alerts.read")
  @Query(() => [AlertRuleModel])
  async alertRules(@Context("req") req: GqlRequest): Promise<AlertRuleModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const rules = await this.alerts.listRules(requester.orgId);
    return rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description ?? undefined,
      severity: rule.severity,
      status: rule.status,
      metricProvider: rule.metricProvider,
      metricSlug: rule.metricSlug,
      operator: rule.operator,
      thresholdValue: rule.thresholdValue ? Number(rule.thresholdValue) : null,
      thresholdLower: rule.thresholdLower ? Number(rule.thresholdLower) : null,
      thresholdUpper: rule.thresholdUpper ? Number(rule.thresholdUpper) : null,
      changeWindowMin: rule.changeWindowMin,
      cooldownSeconds: rule.cooldownSeconds,
      checkIntervalSec: rule.checkIntervalSec,
      lastTriggeredAt: rule.lastTriggeredAt ?? undefined,
      metadata: rule.metadata as Record<string, unknown> | null,
      channels: rule.channels
        .map((link) => link.channel)
        .filter((channel): channel is NonNullable<typeof channel> => !!channel)
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          target: channel.target,
          createdAt: channel.createdAt,
          updatedAt: channel.updatedAt
        }))
    }));
  }

  @HasPermission("alerts.read")
  @Query(() => [AlertEventModel])
  async alertEvents(
    @Context("req") req: GqlRequest,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number,
    @Args("metricSlug", { type: () => String, nullable: true }) metricSlug?: string
  ): Promise<AlertEventModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const events = await this.alerts.listEvents(requester.orgId, limit ?? 50, metricSlug);
    return events.map((event) => ({
      id: event.id,
      triggeredAt: event.triggeredAt,
      metricValue: Number(event.metricValue),
      changePercent: event.changePercent ?? undefined,
      severity: event.severity,
      status: event.status,
      message: event.message ?? undefined,
      context: event.context as Record<string, unknown> | null,
      deliveries:
        event.deliveries?.map((delivery) => ({
          id: delivery.id,
          status: delivery.status,
          error: delivery.error ?? undefined,
          sentAt: delivery.sentAt ?? undefined,
          channelType: delivery.channelType
        })) ?? []
    }));
  }

  @HasPermission("alerts.manage")
  @Mutation(() => AlertRuleModel)
  async upsertAlertRule(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpsertAlertRuleInput
  ): Promise<AlertRuleModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const rule = await this.alerts.upsertRule(requester.orgId, input, requester.id);
    const hydrated = await this.alerts.listRules(requester.orgId);
    const updated = hydrated.find((entry) => entry.id === rule.id);
    if (!updated) {
      throw new Error("Failed to reload rule");
    }
    return {
      id: updated.id,
      name: updated.name,
      description: updated.description ?? undefined,
      severity: updated.severity,
      status: updated.status,
      metricProvider: updated.metricProvider,
      metricSlug: updated.metricSlug,
      operator: updated.operator,
      thresholdValue: updated.thresholdValue ? Number(updated.thresholdValue) : null,
      thresholdLower: updated.thresholdLower ? Number(updated.thresholdLower) : null,
      thresholdUpper: updated.thresholdUpper ? Number(updated.thresholdUpper) : null,
      changeWindowMin: updated.changeWindowMin,
      cooldownSeconds: updated.cooldownSeconds,
      checkIntervalSec: updated.checkIntervalSec,
      lastTriggeredAt: updated.lastTriggeredAt ?? undefined,
      metadata: updated.metadata as Record<string, unknown> | null,
      channels: updated.channels
        .map((link) => link.channel)
        .filter((channel): channel is NonNullable<typeof channel> => !!channel)
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          target: channel.target,
          createdAt: channel.createdAt,
          updatedAt: channel.updatedAt
        }))
    };
  }

  @HasPermission("alerts.manage")
  @Mutation(() => Boolean)
  async deleteAlertRule(@Context("req") req: GqlRequest, @Args("ruleId") ruleId: string): Promise<boolean> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.alerts.deleteRule(requester.orgId, ruleId);
  }

  @HasPermission("alerts.manage")
  @Mutation(() => AlertChannelModel)
  async createAlertChannel(
    @Context("req") req: GqlRequest,
    @Args("input") input: AlertChannelInput
  ): Promise<AlertChannelModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const channel = await this.alerts.createChannel(requester.orgId, input, requester.id);
    return {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      target: channel.target,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt
    };
  }

  @HasPermission("alerts.manage")
  @Mutation(() => Boolean)
  async triggerAlertRule(@Args("ruleId") ruleId: string): Promise<boolean> {
    await this.alerts.enqueueRuleCheck(ruleId);
    return true;
  }

  @HasPermission("alerts.read")
  @Subscription(() => AlertEventModel, {
    name: "alertEvents",
    resolve: (payload: { event: AlertEventModel }) => ({
      id: payload.event.id,
      triggeredAt: payload.event.triggeredAt,
      metricValue: payload.event.metricValue,
      changePercent: payload.event.changePercent ?? null,
      severity: payload.event.severity,
      status: payload.event.status,
      message: payload.event.message ?? undefined,
      deliveries: []
    })
  })
  alertEventsSubscription(@Context("req") req: GqlRequest) {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return withFilter(
      () => this.pubsub.asyncIterator("alertEvents"),
      (payload: { orgId: string }) => payload.orgId === requester.orgId
    )();
  }
}
