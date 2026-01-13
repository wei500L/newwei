import { IsOptional, IsString, Matches, MinLength } from "class-validator";

export class GeoNominatimTestDto {
  @IsString()
  @MinLength(1)
  query!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/)
  countryCodeAlpha2?: string;
}

