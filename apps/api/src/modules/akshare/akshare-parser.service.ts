import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";

import type { AkshareParserConfig } from "./akshare.types";
import {
  createDefaultParserRegistry,
  LatestParser,
  MacroParser,
  type ParsedDataPoint,
  type ParserContext,
  ParserRegistry,
  TimeseriesParser,
  YearMonthParser,
  YieldCurveParser
} from "./parsers";

/**
 * Service facade for Akshare data parsing
 * Uses strategy pattern with parser registry for O(1) lookup
 */
@Injectable()
export class AkshareParserService {
  private readonly logger = new Logger(AkshareParserService.name);
  private readonly registry: ParserRegistry;

  constructor() {
    this.registry = new ParserRegistry();
    this.registerDefaultParsers();
  }

  /**
   * Register all built-in parsers
   */
  private registerDefaultParsers(): void {
    this.registry.register(new LatestParser());
    this.registry.register(new TimeseriesParser());
    this.registry.register(new MacroParser());
    this.registry.register(new YearMonthParser());
    this.registry.register(new YieldCurveParser());
  }

  /**
   * Parse API payload using the appropriate parser strategy
   * @param config Parser configuration with type discriminator
   * @param payload Raw API response payload
   * @param context Optional context for logging/debugging
   * @returns Array of parsed data points
   * @throws InternalServerErrorException if parser type is not supported
   */
  parsePayload(
    config: AkshareParserConfig,
    payload: unknown,
    context?: ParserContext
  ): ParsedDataPoint[] {
    const parserType = config.type;
    const parser = this.registry.get(parserType);

    if (!parser) {
      this.logger.error(
        {
          slug: context?.slug,
          parserType,
          config,
          registeredTypes: this.registry.getRegisteredTypes()
        },
        "Unsupported Akshare parser type"
      );
      const suffix = context?.slug ? ` for ${context.slug}` : "";
      throw new InternalServerErrorException(
        `Unsupported Akshare parser type: ${String(parserType)}${suffix}`
      );
    }

    return parser.parse(config, payload, context);
  }

  /**
   * Get the parser registry for advanced use cases
   * @returns The parser registry instance
   */
  getRegistry(): ParserRegistry {
    return this.registry;
  }

  /**
   * Check if a parser type is supported
   * @param type Parser type identifier
   * @returns True if parser is registered
   */
  isSupported(type: string): boolean {
    return this.registry.has(type);
  }

  /**
   * Get all supported parser types
   * @returns Array of supported parser type identifiers
   */
  getSupportedTypes(): string[] {
    return this.registry.getRegisteredTypes();
  }
}
