import type { FastifyReply, FastifyRequest } from "fastify";

export const SSE_RETRY_MS = 2_000;
/**
 * Heartbeat interval. Every stream sends a `ping` event, `{ "intervalMs" }`,
 * on connect and then this often. It is a named event rather than an SSE
 * comment because EventSource never shows comments to the page, and the web
 * client's watchdog (web/src/api/stream.ts) has to see pings to tell a quiet
 * stream from a dead one: it replaces a connection after two missed pings.
 */
export const SSE_PING_MS = 5_000;
export const SSE_PING_EVENT = "ping";

/** One open text/event-stream response. */
export class SseStream {
  private closed = false;
  private readonly cleanups: Array<() => void> = [];
  private readonly ping: ReturnType<typeof setInterval>;

  constructor(
    private readonly reply: FastifyReply,
    request: FastifyRequest,
    pingMs: number,
  ) {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.write(`retry: ${SSE_RETRY_MS}\n\n`);
    // The first ping goes out before any application event, so a client
    // knows the interval (and that heartbeats exist) as soon as it connects.
    const ping = `event: ${SSE_PING_EVENT}\ndata: ${JSON.stringify({ intervalMs: pingMs })}\n\n`;
    raw.write(ping);
    this.ping = setInterval(() => this.write(ping), pingMs);
    this.ping.unref();
    request.raw.on("close", () => this.close());
    raw.on("close", () => this.close());
    raw.on("error", () => this.close());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Writes one named event whose data line is the JSON payload. */
  send(event: string, payload: unknown): void {
    this.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  /** Runs `cleanup` once when the stream closes (client or server side). */
  onClose(cleanup: () => void): void {
    if (this.closed) {
      cleanup();
      return;
    }
    this.cleanups.push(cleanup);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Cleanup failures must not keep the stream open.
      }
    }
    const raw = this.reply.raw;
    if (!raw.writableEnded) raw.end();
  }

  private write(chunk: string): void {
    const raw = this.reply.raw;
    if (this.closed || raw.writableEnded || raw.destroyed) return;
    raw.write(chunk);
  }
}

/** Tracks every open stream so server shutdown can end them. */
export class SseHub {
  private readonly streams = new Set<SseStream>();

  constructor(private readonly pingMs = SSE_PING_MS) {}

  get size(): number {
    return this.streams.size;
  }

  open(request: FastifyRequest, reply: FastifyReply): SseStream {
    const stream = new SseStream(reply, request, this.pingMs);
    this.streams.add(stream);
    stream.onClose(() => this.streams.delete(stream));
    return stream;
  }

  closeAll(): void {
    for (const stream of [...this.streams]) stream.close();
  }
}

export type Throttle = { schedule(): void; cancel(): void };

/**
 * Trailing throttle: the first schedule() arms a timer and `fn` runs when it
 * fires, reading the latest state, so at most one run per `intervalMs`.
 */
export function trailingThrottle(fn: () => void, intervalMs: number): Throttle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, intervalMs);
      timer.unref();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
