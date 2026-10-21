// Fixed-window rate limiter with a hard bound on the number of tracked keys.
//
// Keys are whatever the caller passes; the scheduler passes the AUTHENTICATED
// user id, never a client-supplied header such as x-forwarded-for, so a
// caller cannot reset its own counter by changing a header.
//
// Memory is bounded two ways:
//   - TTL: an entry lives only until its window ends. Expired entries are
//     dropped when their key is next seen, when room is needed, and by
//     sweep() (the scheduler calls it from its periodic cleanup).
//   - Size: never more than maxKeys entries. When a new key arrives and the
//     map is full, expired entries go first; if every window is still live,
//     the oldest window is dropped to make room.
class RateLimiter {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.entries = new Map(); // key -> {count, resetAt}; insertion order = oldest first
  }

  get size() {
    return this.entries.size;
  }

  // Count one request for key. Returns {allowed, remaining, retryAfterMs}.
  hit(key, {limit, windowMs, maxKeys}) {
    const now = this.now();
    let entry = this.entries.get(key);
    if (entry !== undefined && now >= entry.resetAt) {
      this.entries.delete(key);
      entry = undefined;
    }
    if (entry === undefined) {
      if (this.entries.size >= maxKeys) this.makeRoom(now, maxKeys);
      entry = {count: 0, resetAt: now + windowMs};
      this.entries.set(key, entry);
    }
    if (entry.count >= limit) {
      return {allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now};
    }
    entry.count += 1;
    return {allowed: true, remaining: limit - entry.count, retryAfterMs: 0};
  }

  // Free at least one slot below maxKeys.
  makeRoom(now, maxKeys) {
    this.sweep(now);
    while (this.entries.size > 0 && this.entries.size >= maxKeys) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  // Drop every entry whose window has ended.
  sweep(now = this.now()) {
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) this.entries.delete(key);
    }
  }
}

module.exports = { RateLimiter };
