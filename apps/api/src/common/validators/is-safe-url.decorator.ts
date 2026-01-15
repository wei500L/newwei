import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from "class-validator";

import { validateSsrfUrl, validateSsrfUrlAsync } from "./ssrf-url.validator";

/**
 * Custom validator constraint for SSRF-safe URLs
 */
@ValidatorConstraint({ name: "isSafeUrl", async: true })
export class IsSafeUrlConstraint implements ValidatorConstraintInterface {
  private lastError: string = "";

  async validate(value: unknown, args: ValidationArguments): Promise<boolean> {
    if (typeof value !== "string") {
      this.lastError = "URL must be a string";
      return false;
    }

    // First perform synchronous validation
    const syncResult = validateSsrfUrl(value);
    if (!syncResult.valid) {
      this.lastError = syncResult.reason || "URL failed SSRF validation";
      return false;
    }

    // Then perform async validation with DNS resolution
    const asyncResult = await validateSsrfUrlAsync(value);
    if (!asyncResult.valid) {
      this.lastError = asyncResult.reason || "URL failed SSRF validation";
      return false;
    }

    return true;
  }

  defaultMessage(args: ValidationArguments): string {
    return this.lastError || "URL is not safe (potential SSRF vulnerability)";
  }
}

/**
 * Decorator to validate URLs against SSRF attacks
 * Blocks internal IPs, cloud metadata endpoints, and localhost variations
 *
 * @example
 * class CreateCrawlTaskDto {
 *   @IsUrl()
 *   @IsSafeUrl()
 *   url: string;
 *
 *   @IsUrl(undefined, { each: true })
 *   @IsSafeUrl({ each: true })
 *   additionalUrls?: string[];
 * }
 */
export function IsSafeUrl(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsSafeUrlConstraint,
    });
  };
}
