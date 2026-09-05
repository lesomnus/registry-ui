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
 * # Why the collected list is still sorted
 *
 * Tags come back in lexical order because the spec says three times that they
 * MUST. `_catalog` is not in the spec at all -- it is a registry extension --
 * and the one this fleet runs is *nearly* sorted and not quite: it puts
 * `hday/welcome` before `hday-jp72-base`, having compared something other than
 * bytes. So the collected names are sorted here rather than trusted, which
 * costs a sort of what is already in memory and means a late page can land in
 * the middle. That is already handled: every redraw holds the scroll anchor,
 * so a row arriving above the one you are reading does not move it.
 */

export type Page<T> = {
  items: T[];
  /** What to send back as `last`, or undefined when that was the end. */
  cursor?: string;
};

export type Pager<T> = {
  /** Everything collected so far, sorted. */
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
  compare: (a: T, b: T) => number,
  maxPages = 1000,
): Pager<T> {
  const collected = new Set<T>();
  let items: T[] = [];
  let cursor: string | undefined;
  let done = false;
  let pages = 0;
  let inFlight: Promise<boolean> | undefined;

  const fetchOne = async (): Promise<boolean> => {
    const page = await fetchPage(cursor);
    pages++;

    const before = collected.size;
    for (const item of page.items) {
      collected.add(item);
    }

    // A cursor that does not move, or a page that adds nothing, is a registry
    // that would otherwise be asked forever.
    const next = page.cursor;
    if (next === undefined || next === cursor || collected.size === before || pages >= maxPages) {
      done = true;
    } else {
      cursor = next;
    }

    if (collected.size === before) {
      return false;
    }

    items = [...collected].sort(compare);
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
