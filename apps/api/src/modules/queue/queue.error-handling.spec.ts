import {
  classifyQueueError,
  QueueErrorKind,
  QueuePermanentError,
} from "./queue.error-handling";

describe("queue.error-handling", () => {
  it("classifies QueuePermanentError as permanent", () => {
    const classified = classifyQueueError(new QueuePermanentError("bad data"));
    expect(classified.kind).toBe(QueueErrorKind.Permanent);
  });

  it("classifies ZodError as permanent", () => {
    const zodLike = {
      name: "ZodError",
      message: "invalid payload",
      issues: [{ path: ["url"], message: "Required" }],
    };
    const classified = classifyQueueError(zodLike);
    expect(classified.kind).toBe(QueueErrorKind.Permanent);
  });

  it("classifies axios-like 5xx errors as transient", () => {
    const axiosLike = {
      name: "AxiosError",
      message: "Bad Gateway",
      isAxiosError: true,
      response: { status: 502 },
    };
    const classified = classifyQueueError(axiosLike);
    expect(classified.kind).toBe(QueueErrorKind.Transient);
  });

  it("classifies axios-like 4xx errors as permanent", () => {
    const axiosLike = {
      name: "AxiosError",
      message: "Bad Request",
      isAxiosError: true,
      response: { status: 400 },
    };
    const classified = classifyQueueError(axiosLike);
    expect(classified.kind).toBe(QueueErrorKind.Permanent);
  });

  it("classifies system ECONNRESET as transient", () => {
    const systemError = { name: "Error", message: "reset", code: "ECONNRESET" };
    const classified = classifyQueueError(systemError);
    expect(classified.kind).toBe(QueueErrorKind.Transient);
  });
});

