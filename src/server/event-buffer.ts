import type { WebEvent } from './types.js';

export interface EventCursor {
  epoch: string;
  seq: number;
}

export interface EventReplay {
  events: WebEvent[];
  resync: boolean;
}

/** Keeps a bounded in-memory event window for browser reconnections. */
export class EventBuffer {
  private readonly events: WebEvent[] = [];

  constructor(private readonly capacity = 1_000) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Event buffer capacity must be a positive integer.');
  }

  append(event: WebEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
  }

  clear(): void {
    this.events.length = 0;
  }

  replay(cursor?: EventCursor): EventReplay {
    if (!cursor || !Number.isInteger(cursor.seq) || cursor.seq < 0) return { events: [...this.events], resync: true };
    const latest = this.events.at(-1);
    if (latest && cursor.epoch !== latest.epoch) return { events: [...this.events], resync: true };
    if (!latest && cursor.epoch === '') return { events: [], resync: false };
    if (!latest || cursor.seq > latest.seq) return { events: [...this.events], resync: true };

    const earliest = this.events[0];
    if (earliest && cursor.seq < earliest.seq - 1) return { events: [...this.events], resync: true };
    return { events: this.events.filter((event) => event.seq > cursor.seq), resync: false };
  }
}
