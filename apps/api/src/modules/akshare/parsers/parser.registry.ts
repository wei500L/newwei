import { LatestParser } from "./latest.parser";
import { MacroParser } from "./macro.parser";
import type { IParser } from "./parser.interface";
import { TimeseriesParser } from "./timeseries.parser";
import { YearMonthParser } from "./year-month.parser";
import { YieldCurveParser } from "./yield-curve.parser";

/**
 * Registry for parser strategies
 * Provides O(1) lookup by parser type
 */
export class ParserRegistry {
  private readonly parsers = new Map<string, IParser>();

  /**
   * Register a parser strategy
   * @param parser Parser instance to register
   */
  register(parser: IParser): void {
    this.parsers.set(parser.type, parser);
  }

  /**
   * Get a parser by type
   * @param type Parser type identifier
   * @returns Parser instance or undefined if not found
   */
  get(type: string): IParser | undefined {
    return this.parsers.get(type);
  }

  /**
   * Check if a parser type is registered
   * @param type Parser type identifier
   * @returns True if parser is registered
   */
  has(type: string): boolean {
    return this.parsers.has(type);
  }

  /**
   * Get all registered parser types
   * @returns Array of registered parser type identifiers
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.parsers.keys());
  }

  /**
   * Get the number of registered parsers
   */
  get size(): number {
    return this.parsers.size;
  }
}

/**
 * Create a pre-configured parser registry with all built-in parsers
 */
export function createDefaultParserRegistry(): ParserRegistry {
  const registry = new ParserRegistry();
  registry.register(new LatestParser());
  registry.register(new TimeseriesParser());
  registry.register(new MacroParser());
  registry.register(new YearMonthParser());
  registry.register(new YieldCurveParser());

  return registry;
}
