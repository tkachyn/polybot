import type { ApiErrorCode, PriceMovedDetails } from "../api/dto.js";

/**
 * An expected, user-facing failure of a domain operation. The HTTP layer maps
 * `code` straight onto `ApiError.code` (and `details` onto `ApiError.details`),
 * so messages must be safe to show.
 */
export class DomainError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: PriceMovedDetails;

  constructor(code: ApiErrorCode, message: string, details?: PriceMovedDetails) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    if (details) this.details = details;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
