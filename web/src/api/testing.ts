/**
 * Test doubles for the stream layer. Only tests import this module.
 */
import type { EventSourceLike } from "./stream";

/** An EventSource the test drives by hand. */
export class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** The response headers arrived. */
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent);
  }

  /** A server heartbeat, as src/api/sse.ts sends it. */
  ping(intervalMs: number): void {
    this.emit("ping", JSON.stringify({ intervalMs }));
  }

  /** `closed`: the browser gave up (HTTP error); otherwise it retries by itself. */
  fail(closed: boolean): void {
    this.readyState = closed ? 2 : 0;
    this.onerror?.(new Event("error"));
  }
}
