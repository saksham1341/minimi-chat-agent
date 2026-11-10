/** A tiny async queue: producers push, one consumer iterates. Lets callbacks feed a generator. */
export class Channel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private closed = false;
  private failure: unknown = null;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: item, done: false });
    } else this.items.push(item);
  }

  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    if (error !== undefined) this.failure = error;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) {
        if (this.failure !== null) throw this.failure;
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => (this.waiting = resolve));
      if (next.done) {
        if (this.failure !== null) throw this.failure;
        return;
      }
      yield next.value;
    }
  }
}
