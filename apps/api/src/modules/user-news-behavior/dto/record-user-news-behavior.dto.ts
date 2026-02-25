import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export const USER_NEWS_BEHAVIOR_EVENT_TYPES = [
  "view",
  "click",
  "open_event",
  "open_item",
  "bookmark",
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
