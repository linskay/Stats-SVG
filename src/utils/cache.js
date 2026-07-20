/**
 * A small bounded TTL cache for data returned by third-party services.
 * Expired entries are removed on every read/write, so inactive keys do not
 * remain in a long-lived server process.
 */
export function createTtlCache({ ttl, maxSize }) {
  const entries = new Map();

  function removeExpired(now = Date.now()) {
    for (const [key, entry] of entries) {
      if (now - entry.timestamp >= ttl) entries.delete(key);
    }
  }

  return {
    get(key) {
      removeExpired();
      const entry = entries.get(key);
      if (!entry) return undefined;

      // Refresh insertion order so eviction is least-recently-used.
      entries.delete(key);
      entries.set(key, entry);
      return entry.data;
    },

    set(key, data) {
      removeExpired();
      entries.delete(key);
      entries.set(key, { data, timestamp: Date.now() });

      while (entries.size > maxSize)
        entries.delete(entries.keys().next().value);
    },
  };
}

/**
 * Deduplicates concurrent work for the same cache key.
 *
 * Completed requests are deliberately not retained here; callers should use a
 * TTL cache for completed values. This map only covers the interval while an
 * upstream request is in progress.
 */
export function createSingleFlight() {
  const inFlight = new Map();

  return function singleFlight(cacheKey, request) {
    const existingRequest = inFlight.get(cacheKey);
    if (existingRequest) return existingRequest;

    const promise = (async () => {
      try {
        return await request();
      } finally {
        // Do not remove a newer request should the map be reused meanwhile.
        if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey);
      }
    })();

    inFlight.set(cacheKey, promise);
    return promise;
  };
}
