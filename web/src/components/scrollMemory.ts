/**
 * Scroll offsets of the scrolling pages, one per history entry
 * (`location.key`), so Back and Forward return to where a page was left.
 * The shell never scrolls the document (each <Page> scrolls its own
 * container), so the browser's own scroll restoration never applies.
 */

export type NavigationKind = "POP" | "PUSH" | "REPLACE";

/** Offsets by history key. Oldest entries are dropped past `limit`. */
export class ScrollMemory {
  private readonly offsets = new Map<string, number>();
  private readonly limit: number;

  constructor(limit = 100) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  save(key: string, top: number): void {
    if (!Number.isFinite(top)) return;
    // Re-inserting moves the key to the newest end.
    this.offsets.delete(key);
    this.offsets.set(key, Math.max(0, Math.round(top)));
    while (this.offsets.size > this.limit) {
      const oldest = this.offsets.keys().next();
      if (oldest.done) break;
      this.offsets.delete(oldest.value);
    }
  }

  get(key: string): number | undefined {
    return this.offsets.get(key);
  }

  get size(): number {
    return this.offsets.size;
  }
}

/**
 * The offset to restore for a navigation: Back and Forward (POP) return to
 * the saved one; a link or a replace starts wherever the page renders.
 */
export function restoreTarget(memory: ScrollMemory, key: string, kind: NavigationKind): number | null {
  if (kind !== "POP") return null;
  const top = memory.get(key);
  return top !== undefined && top > 0 ? top : null;
}
