import { cursorFor } from "./catalog";
import type { Page } from "./pager";
import type { RegistryClient } from "./registry";

/**
 * One page of a repository's tags.
 *
 * Paged the same way `_catalog` is, and asking for a large `n` is not the same
 * as asking for all of them: a registry may answer with fewer and say where the
 * rest are. Taking what comes back and stopping drops the remainder without
 * saying so, which on a repository with thousands of tags is a list that looks
 * complete and is not.
 *
 * Unlike `_catalog`, the order here is guaranteed: the spec says three times
 * that tags MUST come back in lexical order. So a later page belongs after the
 * ones before it, and the pager's sort is only insurance.
 */
export async function tagPage(
  client: RegistryClient,
  repository: string,
  cursor: string | undefined,
  pageSize = 500,
): Promise<Page<string>> {
  const res = await client.repo(repository).tags.list({ n: pageSize, last: cursor });
  const items = res.unwrap().tags ?? [];
  return { items, cursor: cursorFor(res.raw, items, pageSize) };
}
