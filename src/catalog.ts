import type { Page } from "./pager";
import type { RegistryClient } from "./registry";

/**
 * One page of the repository list.
 *
 * `_catalog` is not in the distribution spec. The registries that implement it
 * page it with `n` and `last` and say where the next page is in a `Link`
 * header, so one request is not an answer -- it is the first of them. See
 * pager.ts for who asks for the rest and when.
 *
 * The cursor is taken from the link rather than from the last name returned,
 * because the two are not always the same thing: a registry deriving
 * repositories from object keys hands back a key.
 */
export async function repositoryPage(
  client: RegistryClient,
  cursor: string | undefined,
  pageSize = 500,
): Promise<Page<string>> {
  // Awaited rather than unwrapped: `unwrap()` answers the value alone, and the
  // cursor is in a header on the response beside it.
  const res = await client.catalog({ n: pageSize, last: cursor });
  const items = res.unwrap().repositories ?? [];

  return { items, cursor: cursorFor(res.raw, items, pageSize) };
}

/**
 * Where the next page starts, or nothing when this was the last one.
 *
 * A `Link` is the answer when there is one. A browser is often not allowed to
 * read it -- CORS hides every response header but a short safelist unless the
 * registry says otherwise, and most do not -- so the last name returned stands
 * in, which is what the spec says to send back.
 *
 * A short page ends the walk. The spec allows fewer than `n` results **only**
 * when that is all there is or a `Link` says otherwise, so a short page with no
 * link is the end, and asking again would be one wasted round trip per list
 * just to be told nothing.
 */
export function cursorFor(res: Response, items: string[], pageSize: number): string | undefined {
  const link = nextCursor(res);
  if (link !== undefined) {
    return link;
  }

  return items.length === 0 || items.length < pageSize ? undefined : items[items.length - 1];
}

/** The `last` a `rel="next"` link asks to be given back. */
export function nextCursor(res: Response): string | undefined {
  const link = res.headers.get("Link");
  if (!link) {
    return undefined;
  }

  const match = link.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
  if (!match?.[1]) {
    return undefined;
  }

  try {
    // Relative to anything: only the query is wanted, and a registry that names
    // itself by a host the page cannot reach still names its own cursor.
    return new URL(match[1], "https://registry.invalid").searchParams.get("last") ?? undefined;
  } catch {
    return undefined;
  }
}
