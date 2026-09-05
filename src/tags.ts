import type { RegistryClient } from "./registry";

/**
 * A repository's tags, followed to the end.
 *
 * `tags/list` is paged the same way `_catalog` is, and asking for a large `n`
 * is not the same as asking for all of them: a registry may answer with fewer
 * and say where the rest are. Asking once and taking what comes back drops the
 * remainder without saying so, which on a repository with thousands of tags is
 * a list that looks complete and is not.
 */
export async function listTags(client: RegistryClient, repository: string, pageSize = 1000, maxPages = 100): Promise<string[]> {
  const collected = new Set<string>();
  let last: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    // Awaited rather than unwrapped: `unwrap()` answers the value alone, and
    // the cursor is in a header on the response beside it.
    const res = await client.repo(repository).tags.list({ n: pageSize, last });
    const tags = res.unwrap().tags ?? [];
    if (tags.length === 0) {
      break;
    }

    const before = collected.size;
    for (const tag of tags) {
      collected.add(tag);
    }

    // A browser is often not allowed to read `Link`: CORS hides every response
    // header but a short safelist unless the registry says otherwise, and most
    // do not. The last name returned is what the spec says to send back, so it
    // stands in -- and a page that adds nothing new ends the walk, since a
    // registry whose cursor is not a name would otherwise be asked forever.
    last = nextCursor(res.raw) ?? tags[tags.length - 1];
    if (last === undefined || collected.size === before) {
      break;
    }
  }

  return [...collected];
}

/** The `last` a `rel="next"` link asks to be given back. */
function nextCursor(res: Response): string | undefined {
  const link = res.headers.get("Link");
  if (!link) {
    return undefined;
  }

  const match = link.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
  if (!match?.[1]) {
    return undefined;
  }

  try {
    return new URL(match[1], "https://registry.invalid").searchParams.get("last") ?? undefined;
  } catch {
    return undefined;
  }
}
