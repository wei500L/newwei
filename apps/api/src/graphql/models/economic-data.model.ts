import { Field, Float, GraphQLISODateTime, ObjectType, registerEnumType } from "@nestjs/graphql";
import { EconomicDataFrequency, EconomicDataRunStatus, EconomicDataValueType } from "@prisma/client";

registerEnumType(EconomicDataFrequency, {
  name: "EconomicDataFrequency"
});

registerEnumType(EconomicDataRunStatus, {
  name: "EconomicDataRunStatus"
});

registerEnumType(EconomicDataValueType, {
  name: "EconomicDataValueType"
});

@ObjectType()
export class EconomicDataItemModel {
  @Field()
  slug!: string;

  @Field()
  displayName!: string;

  @Field({ nullable: true })
  groupLabel?: string;
}

@ObjectType()
export class EconomicDataPointModel {
  @Field(() => GraphQLISODateTime)
  timestamp!: Date;

  @Field(() => Float)
  value!: number;

  @Field({ nullable: true })
  unit?: string | null;

  @Field({ nullable: true })
  sourceField?: string | null;

  @Field(() => EconomicDataValueType)
  dataType!: EconomicDataValueType;

  @Field(() => EconomicDataItemModel)
  item!: EconomicDataItemModel;
}

@ObjectType()
export class EconomicDataFetchConfigModel {
  @Field()
  id!: string;

  @Field(() => EconomicDataFrequency)
  frequency!: EconomicDataFrequency;

  @Field({ nullable: true })
  repeatCron?: string | null;

  @Field()
  isEnabled!: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastRunAt?: Date | null;

  @Field(() => EconomicDataRunStatus, { nullable: true })
  lastStatus?: EconomicDataRunStatus | null;

  @Field({ nullable: true })
  lastError?: string | null;

  @Field(() => EconomicDataItemModel)
  item!: EconomicDataItemModel;
}
