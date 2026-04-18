import { BadRequestException } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export const USER_NEWS_BEHAVIOR_EVENT_TYPES = [
  "view",
  "click",
  "open_event",
  "open_item",
  "bookmark",
  "share",
  "engaged_read",
  "deep_read",
  "completed_read",
  "not_interested",
  "unsubscribe",
] as const;

export type UserNewsBehaviorEventType =
  (typeof USER_NEWS_BEHAVIOR_EVENT_TYPES)[number];

export class RecordUserNewsBehaviorDto {
  @IsIn(USER_NEWS_BEHAVIOR_EVENT_TYPES)
  type!: UserNewsBehaviorEventType;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  itemId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  eventId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  source?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  topics?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  entities?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;
}

const READ_MILESTONE_EVENT_TYPES = new Set<UserNewsBehaviorEventType>([
  "engaged_read",
  "deep_read",
  "completed_read",
]);

export function validateRecordUserNewsBehaviorDto(
  body: RecordUserNewsBehaviorDto,
): void {
  const itemId = typeof body.itemId === "string" && body.itemId.trim() ? body.itemId.trim() : "";
  const eventId =
    typeof body.eventId === "string" && body.eventId.trim() ? body.eventId.trim() : "";
  const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "";
  const topics = Array.isArray(body.topics)
    ? body.topics
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];
  const entities = Array.isArray(body.entities)
    ? body.entities
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];

  if (READ_MILESTONE_EVENT_TYPES.has(body.type) && !itemId) {
    throw new BadRequestException("itemId is required for reading milestone events");
  }

  if (body.type === "not_interested") {
    const targetFamilies = [
      itemId ? "item" : null,
      eventId ? "event" : null,
      source ? "source" : null,
      topics.length > 0 ? "topic" : null,
      entities.length > 0 ? "entity" : null,
    ].filter((entry): entry is string => Boolean(entry));

    if (topics.length > 1 || entities.length > 1) {
      throw new BadRequestException(
        "not_interested only supports a single topic or entity target",
      );
    }
    if (targetFamilies.length !== 1) {
      throw new BadRequestException(
        "not_interested requires exactly one target family",
      );
    }
  }

  if (body.type === "unsubscribe") {
    const hasTopic = topics.length > 0;
    const hasEntity = entities.length > 0;
    if (topics.length > 1 || entities.length > 1) {
      throw new BadRequestException(
        "unsubscribe only supports a single topic or entity target",
      );
    }
    if (itemId || eventId || source || hasTopic === hasEntity) {
      throw new BadRequestException(
        "unsubscribe requires exactly one topic or one entity target",
      );
    }
  }
}
