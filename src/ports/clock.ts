/** What time it is. A port so a demo can pretend it is next Tuesday and tests can pin it. */
export interface Clock {
  now(): Date;
}
