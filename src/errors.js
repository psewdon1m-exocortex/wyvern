export class WyvernError extends Error {
  constructor(code, status = 400, retryable = false) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function fault(code, status = 400, retryable = false) {
  throw new WyvernError(code, status, retryable);
}

export function publicError(error, requestId) {
  const known = error instanceof WyvernError;
  return {
    status: known ? error.status : 500,
    body: { error: {
      code: known ? error.code : "internal_error",
      message: known ? error.code.replaceAll("_", " ") : "internal error",
      retryable: known ? error.retryable : false,
      request_id: requestId,
    } },
  };
}
