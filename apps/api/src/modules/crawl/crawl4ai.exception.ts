export class Crawl4aiRequestException extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "Crawl4aiRequestException";
  }
}
