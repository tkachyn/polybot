import type { ApiErrorCode } from "../api/dto.js";

/**
 * An expected, user-facing failure of a domain operation. The HTTP layer maps
 * `code` straight onto `ApiError.code`, so messages must be safe to show.
 */
export class DomainError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
