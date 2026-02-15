import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsOptional, IsString, MaxLength } from "class-validator";

export class EmailTestDto {
  @ApiPropertyOptional({
    description: "Optional recipient email. Defaults to configured SMTP user when omitted.",
    example: "admin@example.com"
  })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  @IsEmail()
  to?: string;

  @ApiPropertyOptional({
    description: "Optional subject for the test email.",
    example: "Test email"
  })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  subject?: string;
}

export class EmailTestResponseDto {
  @ApiProperty({
    description: "Resolved recipient address used to send the test email.",
    example: "admin@example.com"
  })
  to!: string;

  @ApiProperty({
    description: "SMTP provider message ID.",
    example: "<abc123@smtp.example.com>"
  })
  messageId!: string;

  @ApiProperty({
    description: "List of accepted recipient addresses.",
    type: [String],
    example: ["admin@example.com"]
  })
  accepted!: string[];

  @ApiProperty({
    description: "List of rejected recipient addresses.",
    type: [String],
    example: []
  })
  rejected!: string[];
}
