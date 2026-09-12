import { randomId } from "../lib/id";
import { readStorage, writeStorage } from "./storage";

export const USER_ID_STORAGE_KEY = "sm.userId";

/** Server rule for `EnsureUserRequest.userId`. */
export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export function sanitizeUserId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

export function isValidUserId(value: string | null | undefined): value is string {
  return typeof value === "string" && USER_ID_PATTERN.test(value);
}

/** A new id: `crypto.randomUUID()` stripped to [A-Za-z0-9_-]. */
export function createUserId(): string {
  let id = sanitizeUserId(randomId());
  while (id.length < 6) id += sanitizeUserId(randomId());
  return id.slice(0, 64);
}

/**
 * The persisted user id, created and stored on first use. An invalid stored
 * value is replaced.
 */
export function getOrCreateUserId(key: string = USER_ID_STORAGE_KEY): string {
  const stored = readStorage(key);
  if (isValidUserId(stored)) return stored;
  const id = createUserId();
  writeStorage(key, id);
  return id;
}
