import { setTimeout as delay } from 'node:timers/promises';
import { MATCH_MESSAGE } from './registry.mjs';

export class MatchDelivery {
  constructor(registry, send) {
    this.registry = registry;
    this.send = send;
    this.inFlight = new Map();
  }

  deliver(job) {
    const key = [job.client, job.match, job.generation].join(':');
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const attempt = this.attempt(job).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, attempt);
    return attempt;
  }

  async attempt(job) {
    const reservation = this.registry.reserveDelivery(job);
    if (!reservation.chat) return reservation;
    try {
      await this.send(reservation.chat, MATCH_MESSAGE);
    } catch (error) {
      if (!error?.definiteRejection) return { delivery: 'unknown' };
      if (error.status !== 429) {
        this.registry.finishDelivery(job, 'rejected');
        return { delivery: 'rejected' };
      }
      const seconds = Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter : 5;
      const retryAt = Date.now() + seconds * 1000;
      this.registry.finishDelivery(job, 'pending', retryAt);
      return { delivery: 'pending', retryAt };
    }
    this.registry.finishDelivery(job, 'delivered');
    return { delivery: 'delivered' };
  }

  async retryUntilStopped(signal) {
    while (!signal.aborted) {
      for (const job of this.registry.dueDeliveries()) {
        if (signal.aborted) return;
        await this.deliver(job);
      }
      try { await delay(1000, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  }
}
