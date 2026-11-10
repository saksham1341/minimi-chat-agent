/**
 * Things said to a run while it is still working. Ported from Keel's `keel/agents/inbox.py`.
 *
 * Interrupting mid-request is not on offer: a model call is in flight and its tool results are
 * owed back, and injecting a message into that is how a conversation desynchronises. So a message
 * waits here and joins at the next honest seam: after a round's tool results are back, before the
 * next request goes out, the soonest it could be taken into account.
 *
 * Not a queue anything waits on: the loop takes whatever is here and carries on. Drained whole,
 * because two messages sent in quick succession are two things said before an answer, and feeding
 * them a round apart would have the model answer the first while the second sat here.
 */
import { randomUUID } from "node:crypto";

export interface Waiting {
  id: string;
  text: string;
}

export class Inbox {
  private waiting: Waiting[] = [];

  put(text: string): Waiting {
    const item = { id: randomUUID(), text };
    this.waiting.push(item);
    return item;
  }

  drain(): Waiting[] {
    const taken = this.waiting;
    this.waiting = [];
    return taken;
  }

  get size(): number {
    return this.waiting.length;
  }
}
