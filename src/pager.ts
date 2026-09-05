/**
 * A list a registry hands over one page at a time.
 *
 * Both listings work the same way -- `n` and `last`, a `Link` when there is
 * more -- and both were walked to the end before anything was drawn. That is
 * fine for two hundred repositories and wrong for twenty thousand: it is a
 * pile of sequential round trips for a screen that shows twenty rows.
 *
 * So a page is fetched when it is wanted. The list asks for more as it nears
 * the end of what it has, and a filter asks for all of it, because a filter
 * over a tenth of the names is a wrong answer rather than a partial one.
 *
 * # The order is the registry's, and pages only ever append
 *
 * This used to sort what it had collected, which meant a late page could land
 * in the middle of a list somebody was reading. It no longer does, for a reason
 * better than taste: **the registry's order is the only self-consistent one.**
 * Paging is `last=<the last item of the previous page>`, so the sequence the
 * registry walks in *is* the sequence the cursor steps through. Re-sorting
 * fights that. The one this fleet runs puts `hday/welcome` before
 * `hday-jp72-base` -- it compares something other than bytes -- and sorting
 * that back made the display disagree with the pagination it came from.
 *
 * Tags need no help anyway: the spec says three times that they MUST come back
 * in lexical order.
 *
 * # Knowing what is new
 *
 * The set that dedupes is also the answer to that: an item already in it has
 * been seen, and one that is not is appended. A `Set` keeps insertion order, so
 * the collected list is arrival order for free -- there is no second structure
 * and nothing to keep in step.
 *
 * Dedupe is not paranoia. A registry whose cursor is an object key rather than
 * a name can hand back an overlap, and a tag written while the walk is in
 * progress can appear on two pages. It is also the loop-breaker: a page that
 * adds nothing is a walk that is not advancing.
 */

export type Page<T> = {
  items: T[];
  /** What to send back as `last`, or undefined when that was the end. */
  cursor?: string;
};

export type Pager<T> = {
  /** Everything collected so far, in the order the registry listed it. */
  readonly items: T[];
  /** No more pages: what is here is all of it. */
  readonly done: boolean;
  /** A page is in flight. */
  readonly loading: boolean;
  /** How many pages have come back. */
  readonly pages: number;
  /**
   * Fetches the next page, if there is one and nothing else is fetching.
   * Answers whether anything was added.
   */
  more: () => Promise<boolean>;
  /** Fetches every remaining page, reporting after each. */
  drain: () => Promise<void>;
};

/**
 * @param fetchPage asked for one page, given the cursor the last one ended on.
 * @param onPage called after every page that added something, so a list can
 * redraw as they arrive rather than at the end.
 * @param maxPages a stop, for a registry whose cursor never resolves.
 */
export function pager<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  onPage: () => void,
  maxPages = 1000,
): Pager<T> {
  const collected = new Set<T>();
  const items: T[] = [];
  let cursor: string | undefined;
  let done = false;
  let pages = 0;
  let inFlight: Promise<boolean> | undefined;

  const fetchOne = async (): Promise<boolean> => {
    const page = await fetchPage(cursor);
    pages++;

    // Appended in the order they arrived, and only the ones not already here.
    // The set is what "already here" means; nothing else has to track it.
    let added = 0;
    for (const item of page.items) {
      if (collected.has(item)) {
        continue;
      }

      collected.add(item);
      items.push(item);
      added++;
    }

    // A cursor that does not move, or a page that adds nothing, is a registry
    // that would otherwise be asked forever.
    const next = page.cursor;
    if (next === undefined || next === cursor || added === 0 || pages >= maxPages) {
      done = true;
    } else {
      cursor = next;
    }

    if (added === 0) {
      return false;
    }

    onPage();
    return true;
  };

  return {
    get items() {
      return items;
    },
    get done() {
      return done;
    },
    get loading() {
      return inFlight !== undefined;
    },
    get pages() {
      return pages;
    },

    async more() {
      if (done) {
        return false;
      }

      // One at a time. The list asks on every scroll frame near the bottom, and
      // without this each of those would be a page.
      if (inFlight !== undefined) {
        return await inFlight;
      }

      inFlight = fetchOne().finally(() => {
        inFlight = undefined;
      });
      return await inFlight;
    },

    async drain() {
      while (!done) {
        await this.more();
      }
    },
  };
}
