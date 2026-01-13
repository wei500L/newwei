import { HttpException, HttpStatus, type HttpExceptionOptions } from "@nestjs/common";

/**
 * Minimal re-implementation of NestJS' TooManyRequestsException, which is missing
 * from the current @nestjs/common distribution. This keeps consumers focused on
 * HttpException semantics without leaking status codes.
 */
export class TooManyRequestsException extends HttpException {
  constructor(
    objectOrError?: string | Record<string, unknown>,
    descriptionOrOptions: string | HttpExceptionOptions = "Too Many Requests"
  ) {
    const { description, httpExceptionOptions } = HttpException.extractDescriptionAndOptionsFrom(
      descriptionOrOptions
    );
    const descriptionText = description ?? "Too Many Requests";
    const body =
      objectOrError === undefined
        ? HttpException.createBody(null, descriptionText, HttpStatus.TOO_MANY_REQUESTS)
        : typeof objectOrError === "string"
          ? HttpException.createBody(objectOrError, descriptionText, HttpStatus.TOO_MANY_REQUESTS)
          : HttpException.createBody(objectOrError);
    super(
      body,
      HttpStatus.TOO_MANY_REQUESTS,
      httpExceptionOptions
    );
  }
}
