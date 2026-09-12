/** Joins class names, skipping falsy parts. CSS-module lookups may be undefined. */
export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  let out = "";
  for (const part of parts) {
    if (part) out = out ? `${out} ${part}` : part;
  }
  return out;
}
