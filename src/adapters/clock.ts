import type { Clock } from "../ports/clock.ts";

export class SystemClock implements Clock {
  now() {
    return new Date();
  }
}

/**
 * A clock that started at a chosen moment and runs forward in real time. Set AGENT_NOW to hold a
 * conversation "on 3 November", restart with today's date, and ask what changed since.
 */
export class ShiftedClock implements Clock {
  private readonly offset: number;
  constructor(start: Date) {
    this.offset = start.getTime() - Date.now();
  }
  now() {
    return new Date(Date.now() + this.offset);
  }
}
