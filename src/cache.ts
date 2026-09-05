/**
 * Remembering what cannot change.
 *
 * A manifest or a blob fetched by digest is the bytes that digest names: there
 * is no version of it to be stale against, and asking twice is asking the same
 * question. Anything fetched by *tag* is excluded, because a tag is a name
 * somebody can move.
 *
 * # It asks once, not just remembers once
 *
 * The entry is claimed before the fetch, so two callers wanting the same digest
 * at the same time share one request rather than both missing and both asking.
 * Drawing an image index does exactly that -- the children are fetched
 * together, and a digest can be both a child and the subject of a referrer.
 *
 * # It is in memory, and only for the session
 *
 * Not localStorage: these are kilobytes each and localStorage is a synchronous
 * few megabytes shared with everything else on the origin, which is a poor
 * place to put a cache that a reload can rebuild in a second.
 */

/** How many entries to keep. Beyond it, the least recently read goes. */
const capacity = 500;

export class DigestCache {
  /** Insertion order is the eviction order; a read moves an entry to the end. */
  private entries = new Map<string, Promise<unknown>>();

  /**
   * The value for `key`, fetching it if this is the first ask.
   *
   * A rejected fetch is not kept: a request that failed once is a request to
   * try again, not an answer.
   */
  async get<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    const held = this.entries.get(key);
    if (held !== undefined) {
      // Freshly used, so it is the last to be evicted.
      this.entries.delete(key);
      this.entries.set(key, held);
      return (await held) as T;
    }

    const pending = fetch();
    this.entries.set(key, pending);

    try {
      const value = await pending;
      this.evict();
      return value;
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }

  /** Everything forgotten, which is what changing registry means. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    while (this.entries.size > capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        return;
      }

      this.entries.delete(oldest.value);
    }
  }
}

/** Whether a reference names content rather than a name somebody can move. */
export const isDigest = (reference: string): boolean => /^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/.test(reference);
