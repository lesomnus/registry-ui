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
  const collected: string[] = [];
  let last: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const res = await client.repo(repository).tags.list({ n: pageSize, last }).unwrap();
    const tags = res.tags ?? [];
    if (tags.length === 0) {
      break;
    }

    collected.push(...tags);

    last = nextCursor(res.raw);
    if (last === undefined) {
      break;
    }
  }

  return [...new Set(collected)];
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
