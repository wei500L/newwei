import { HttpException, HttpStatus } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";

import { GlobalExceptionFilter } from "./global-exception.filter";

jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }),
  ensureTraceId: () => "test-trace-id",
  getCurrentTraceId: () => undefined
}));

describe("GlobalExceptionFilter", () => {
  it("does not leak HttpException response objects", () => {
    const exceptionEvents = { record: jest.fn() } as unknown as {
      record: (payload: unknown) => void;
    };
    const filter = new GlobalExceptionFilter(exceptionEvents as never);

    const exception = new HttpException(
      {
        statusCode: HttpStatus.BAD_REQUEST,
        message: "Invalid input",
        error: "Bad Request",
        url: "http://internal.service.local",
        secret: "do-not-leak"
      },
      HttpStatus.BAD_REQUEST
    );

    const json = jest.fn();
    const response = {
      setHeader: jest.fn(),
      status: jest.fn(() => ({ json }))
    };
    const request = { url: "/api/example", method: "GET" };

    const host = {
      getType: () => "http",
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request
      })
    } as unknown as ArgumentsHost;

    filter.catch(exception, host);

    expect(response.setHeader).toHaveBeenCalledWith("x-trace-id", "test-trace-id");
    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);

    const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(body.message).toBe("Invalid input");
    expect(body.error).toBe("Bad Request");
    expect(typeof body.error).toBe("string");
    expect(body.traceId).toBe("test-trace-id");
    expect(body).not.toHaveProperty("error.secret");
    expect(body).not.toHaveProperty("error.url");
  });

  it("hides 5xx HttpException messages from clients", () => {
    const exceptionEvents = { record: jest.fn() } as unknown as {
      record: (payload: unknown) => void;
    };
    const filter = new GlobalExceptionFilter(exceptionEvents as never);

    const exception = new HttpException(
      "PrismaClientKnownRequestError: column \"passwordHash\" does not exist",
      HttpStatus.INTERNAL_SERVER_ERROR
    );

    const json = jest.fn();
    const response = {
      setHeader: jest.fn(),
      status: jest.fn(() => ({ json }))
    };
    const request = { url: "/api/example", method: "GET" };

    const host = {
      getType: () => "http",
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request
      })
    } as unknown as ArgumentsHost;

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.message).toBe("Internal server error");
    expect(String(body.message)).not.toContain("Prisma");
  });
});
