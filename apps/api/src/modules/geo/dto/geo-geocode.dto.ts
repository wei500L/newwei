import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, Length, MaxLength, MinLength } from "class-validator";

export class GeoGeocodeDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  query!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 2)
  countryCodeAlpha2?: string;
}

