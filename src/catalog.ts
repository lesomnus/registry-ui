import type { RegistryClient } from "./registry";

/**
 * The repository list, followed to the end.
 *
 * oci-client's catalog extension asks for the whole thing in one request, which
 * a registry is allowed to refuse to answer -- `_catalog` is not in the
 * distribution spec, and the registries that implement it page it with `n` and
 * `last` and say where the next page is in a `Link` header.
 *
 * So this goes through `client.transport` rather than through the extension:
 * the transport is the seam that carries authentication and the forwarder, so
 * borrowing it costs nothing and asking for the pages is a URL away.
 */
export async function listRepositories(client: RegistryClient, pageSize = 500, maxPages = 100): Promise<string[]> {
  const collected: string[] = [];
  let url: string | undefined = `https://${client.domain}/v2/_catalog?n=${pageSize}`;

  for (let page = 0; page < maxPages && url !== undefined; page++) {
    const res: Response = await client.transport.fetch(url);
    if (!res.ok) {
      if (page === 0) {
        throw new Error(`the registry answered ${res.status} for its repository list`);
      }

      break;
    }

    const body = (await res.json()) as { repositories?: string[] };
    const repositories = body.repositories ?? [];
    if (repositories.length === 0) {
      break;
    }

    collected.push(...repositories);
    url = nextLink(res, client.domain);
  }

  return [...new Set(collected)];
}

/**
 * The `rel="next"` link, as something to fetch.
 *
 * A registry names itself in the link, and some name themselves by a host the
 * page cannot reach. The path is the part that means anything, so it is kept
 * and the registry's own domain is put back in front of it.
 */
function nextLink(res: Response, domain: string): string | undefined {
  const link = res.headers.get("Link");
  if (!link) {
    return undefined;
  }

  const match = link.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
  if (!match?.[1]) {
    return undefined;
  }

  try {
    const parsed = new URL(match[1], `https://${domain}`);
    return `https://${domain}${parsed.pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
}
