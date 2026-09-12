/** Random identifiers that work in insecure contexts (plain-http LAN hosts). */

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * A random id: `crypto.randomUUID()` when available (secure contexts only),
 * else 128 bits from `crypto.getRandomValues`, else Math.random.
 */
export function randomId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  try {
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {
    // randomUUID throws outside secure contexts in some browsers.
  }
  if (c && typeof c.getRandomValues === "function") {
    return hex(c.getRandomValues(new Uint8Array(16)));
  }
  let out = "";
  while (out.length < 32) out += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return out.slice(0, 32);
}

/** Idempotency key for `OrderRequest.clientOrderId`. */
export function newClientOrderId(): string {
  return randomId();
}
