/**
 * localStorage with an in-memory fallback. Every access is wrapped in
 * try/catch: storage can be missing (private windows, sandboxed frames,
 * tests) or throw (quota, blocked site data).
 */

const memory = new Map<string, string>();

function storage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function readStorage(key: string): string | null {
  try {
    const value = storage()?.getItem(key);
    if (value !== null && value !== undefined) return value;
  } catch {
    // fall through to memory
  }
  return memory.get(key) ?? null;
}

export function writeStorage(key: string, value: string): void {
  memory.set(key, value);
  try {
    storage()?.setItem(key, value);
  } catch {
    // memory copy is enough for this session
  }
}

export function removeStorage(key: string): void {
  memory.delete(key);
  try {
    storage()?.removeItem(key);
  } catch {
    // ignore
  }
}
