export class VectorClientError extends Error {
  override name = 'VectorClientError' as string;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export class VectorUnauthorizedError extends VectorClientError {
  override name = 'VectorUnauthorizedError' as string;
}

export class VectorServiceUnavailableError extends VectorClientError {
  override name = 'VectorServiceUnavailableError' as string;
}

export class VectorBadResponseError extends VectorClientError {
  override name = 'VectorBadResponseError' as string;
}
