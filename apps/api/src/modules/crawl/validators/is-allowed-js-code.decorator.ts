/**
 * IsAllowedJsCode Class-Validator Decorator
 *
 * Custom class-validator decorator that validates jsCode against the security allowlist.
 * Integrates with NestJS validation pipeline for DTO validation.
 *
 * Security Issue: NP-SEC-002
 * Solution ID: SOL-NP-SEC-002-p5n9
 */

import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments
} from "class-validator";

import { validateJsCode, validateJsCodeArray, MAX_SCRIPT_LENGTH, MAX_SCRIPTS_COUNT } from "./js-code.validator";

@ValidatorConstraint({ name: "isAllowedJsCode", async: false })
export class IsAllowedJsCodeConstraint implements ValidatorConstraintInterface {
  private lastBlockedPatterns: string[] = [];

  validate(value: unknown, args: ValidationArguments): boolean {
    this.lastBlockedPatterns = [];

    // Handle undefined/null - these are valid (optional field)
    if (value === undefined || value === null) {
      return true;
    }

    const options = args.constraints[0] as { each?: boolean } | undefined;

    // If 'each' option is set, validate as array
    if (options?.each) {
      if (!Array.isArray(value)) {
        this.lastBlockedPatterns = ["Expected an array of strings"];
        return false;
      }

      const result = validateJsCodeArray(value as string[]);
      if (!result.valid) {
        this.lastBlockedPatterns = result.blockedPatterns;
        return false;
      }
      return true;
    }

    // Single string validation
    if (typeof value !== "string") {
      this.lastBlockedPatterns = ["Expected a string"];
      return false;
    }

    const result = validateJsCode(value);
    if (!result.valid) {
      this.lastBlockedPatterns = result.blockedPatterns;
      return false;
    }

    return true;
  }

  defaultMessage(args: ValidationArguments): string {
    const propertyName = args.property;

    if (this.lastBlockedPatterns.length > 0) {
      const patterns = this.lastBlockedPatterns.slice(0, 5).join("; ");
      const moreCount = this.lastBlockedPatterns.length - 5;
      const suffix = moreCount > 0 ? ` (and ${moreCount} more)` : "";
      return `${propertyName} contains blocked JavaScript patterns: ${patterns}${suffix}. ` +
        `Only safe DOM operations (scroll, click, querySelector) are allowed. ` +
        `Max ${MAX_SCRIPTS_COUNT} scripts, ${MAX_SCRIPT_LENGTH} chars each.`;
    }

    return `${propertyName} contains invalid JavaScript code`;
  }
}

/**
 * Decorator that validates jsCode against the security allowlist.
 *
 * @param validationOptions - Standard class-validator options plus 'each' for array validation
 * @returns PropertyDecorator
 *
 * @example
 * // Single string validation
 * @IsAllowedJsCode()
 * jsCode?: string;
 *
 * @example
 * // Array validation (validates each element)
 * @IsAllowedJsCode({ each: true })
 * jsCode?: string[];
 */
export function IsAllowedJsCode(
  validationOptions?: ValidationOptions & { each?: boolean }
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      name: "isAllowedJsCode",
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      constraints: [{ each: validationOptions?.each }],
      validator: IsAllowedJsCodeConstraint
    });
  };
}
