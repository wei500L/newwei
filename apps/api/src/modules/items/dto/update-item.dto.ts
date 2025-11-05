import { IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateItemDto {
  @IsString()
  id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  payload?: Record<string, unknown>;
}
