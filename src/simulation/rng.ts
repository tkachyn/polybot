/** Seeded, deterministic pseudo-randomness for the simulation. */

/** 32-bit FNV-1a hash of a string. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: a small, fast generator with a 32-bit state. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export class Rng {
  private readonly next: () => number;

  constructor(readonly seed: string) {
    this.next = mulberry32(hashString(seed));
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer uniform in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("cannot pick from an empty list");
    return items[Math.floor(this.next() * items.length)];
  }

  /** Picks by non-negative weight; falls back to uniform when all are 0. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T {
    const weights = items.map((item) => Math.max(0, weight(item)));
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return this.pick(items);
    let target = this.next() * total;
    for (let index = 0; index < items.length; index += 1) {
      target -= weights[index];
      if (target < 0) return items[index];
    }
    return items[items.length - 1];
  }

  /** A shuffled copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(this.next() * (index + 1));
      [copy[index], copy[swap]] = [copy[swap], copy[index]];
    }
    return copy;
  }

  /** Lowercase hex string of the given length. */
  hex(length: number): string {
    let text = "";
    while (text.length < length) {
      text += Math.floor(this.next() * 16).toString(16);
    }
    return text;
  }

  /** An independent generator derived from this seed and a label. */
  fork(label: string): Rng {
    return new Rng(`${this.seed}/${label}`);
  }
}
