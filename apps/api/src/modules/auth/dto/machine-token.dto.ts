import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreateMachineTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  permissions!: string[];

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
