import { Field, GraphQLISODateTime, Int, ObjectType, registerEnumType } from "@nestjs/graphql";
import GraphQLJSON from "graphql-type-json";
import { NotificationType } from "@prisma/client";

registerEnumType(NotificationType, { name: "NotificationType" });

@ObjectType()
export class NotificationModel {
  @Field()
  id!: string;

  @Field(() => NotificationType)
  type!: NotificationType;

  @Field()
  title!: string;

  @Field(() => String, { nullable: true })
  body?: string | null;

  @Field(() => GraphQLJSON, { nullable: true })
  data?: Record<string, unknown> | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  readAt?: Date | null;
}

@ObjectType()
export class NotificationCountModel {
  @Field(() => Int)
  unread!: number;
}
