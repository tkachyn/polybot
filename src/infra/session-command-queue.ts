export class SessionCommandQueue {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Serializes mutations for one browser session without blocking other
   * racers. A failed command does not poison the queue for later commands.
   */
  run<T>(command: () => Promise<T>): Promise<T> {
    const result = this.tail.then(command);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
