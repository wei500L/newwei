import { IsBoolean, IsString, Matches, MaxLength } from "class-validator";

export class UpdateUserDigestDeliveryDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/)
  time!: string;

  @IsString()
  @MaxLength(128)
  timezone!: string;
}
