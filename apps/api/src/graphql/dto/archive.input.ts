import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  InputType,
  Int,
} from "@nestjs/graphql";
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

import {
  ArchiveRegion,
  ArchiveVertical,
  ArchiveWeight,
} from "../../modules/archive/archive.types";

@InputType()
export class ArchiveQueryInput {
  @Field(() => GraphQLISODateTime)
  @IsDate()
  anchorDate!: Date;

  @Field(() => ArchiveRegion)
  @IsEnum(ArchiveRegion)
  region!: ArchiveRegion;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @Field(() => [ArchiveWeight], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsEnum(ArchiveWeight, { each: true })
  weights?: ArchiveWeight[];

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limitPerVertical?: number;
}

@InputType()
export class ArchiveCalendarInput {
  @Field(() => String)
  @IsString()
  @Matches(/^\d{4}-\d{2}$/)
  month!: string;

  @Field(() => ArchiveRegion, { nullable: true })
  @IsOptional()
  @IsEnum(ArchiveRegion)
  region?: ArchiveRegion;

  @Field(() => ArchiveVertical, { nullable: true })
  @IsOptional()
  @IsEnum(ArchiveVertical)
  vertical?: ArchiveVertical;
}

@ArgsType()
export class ArchiveDetailArgs {
  @Field(() => String)
  @IsString()
  processedArticleId!: string;
}
