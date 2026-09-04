import type { RegistryClient } from "./registry";

/**
 * The repository list, followed to the end.
 *
 * `_catalog` is not in the distribution spec. The registries that implement it
 * page it with `n` and `last` and say where the next page is in a `Link`
 * header, so one request is not an answer -- it is the first of them.
 *
 * The cursor is taken from the link rather than from the last name returned,
 * because the two are not always the same thing: a registry deriving
 * repositories from object keys hands back a key.
 */
/**
 * @param onPage called with everything collected so far, each time a page
 * arrives, so a registry with a hundred pages shows the first one immediately
 * rather than a spinner until the last.
 */
export async function listRepositories(
  client: RegistryClient,
  onPage?: (repositories: string[]) => void,
  pageSize = 500,
  maxPages = 100,
): Promise<string[]> {
  const collected = new Set<string>();
  let last: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const res = await client.catalog({ n: pageSize, last }).unwrap();
    const repositories = res.repositories ?? [];
    if (repositories.length === 0) {
      break;
    }

    for (const repository of repositories) {
      collected.add(repository);
    }

    onPage?.([...collected]);

    last = nextCursor(res.raw);
    if (last === undefined) {
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
    // Relative to anything: only the query is wanted, and a registry that names
    // itself by a host the page cannot reach still names its own cursor.
    return new URL(match[1], "https://registry.invalid").searchParams.get("last") ?? undefined;
  } catch {
    return undefined;
  }
}
