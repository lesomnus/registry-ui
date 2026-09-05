import { DigestCache, isDigest } from "./cache";
import type { RegistryClient } from "./registry";

/**
 * Reading a manifest, and knowing its digest even when nobody will tell you.
 *
 * A registry reports the digest in `Docker-Content-Digest`, and in a browser
 * that header is often not readable: CORS hides every response header except a
 * short safelist unless the registry sends `Access-Control-Expose-Headers`, and
 * most do not. zot sends the digest and does not expose it, so a page talking
 * to it directly is told nothing.
 *
 * The digest is not a fact the registry owns, though. It is the SHA-256 of the
 * manifest bytes, and the bytes are right here. So it is computed, and the
 * header is used only to check the arithmetic -- which makes this stricter than
 * trusting it: a registry that reports a digest its own bytes do not have is
 * saying something worth knowing.
 *
 * Read through `client.transport` rather than `manifests.get()` because the
 * bytes matter: `get()` parses the body, and a digest over re-serialised JSON
 * is a digest of something else.
 */

export type ReadManifest = {
  manifest: unknown;
  /** Absent when it could be neither computed nor read. See `digestOf`. */
  digest?: string;
  mediaType: string;
  /** Set when the registry named a digest and it was not the one the bytes have. */
  mismatch?: string;
  /** Said on the page when the digest had to be taken on trust, or is missing. */
  digestNote?: string;
};

/**
 * What has already been read, by digest.
 *
 * Cleared when the connection changes: the same digest at a different registry
 * is the same bytes, but the same *repository* name at a different registry is
 * not, and the key is built from both.
 */
export const cache = new DigestCache();

export async function readManifest(
  client: RegistryClient,
  repository: string,
  reference: string,
): Promise<ReadManifest> {
  // A tag is a name somebody can move; a digest is the bytes it names.
  if (isDigest(reference)) {
    return await cache.get(`${client.domain}/${repository}@${reference}`, () =>
      fetchManifest(client, repository, reference),
    );
  }

  return await fetchManifest(client, repository, reference);
}

async function fetchManifest(
  client: RegistryClient,
  repository: string,
  reference: string,
): Promise<ReadManifest> {
  const url = `https://${client.domain}/v2/${repository}/manifests/${reference}`;
  const res = await client.transport.fetch(url, {
    method: "GET",
    endpoint: { method: "GET", name: repository, resource: "manifests", reference },
  });

  const body = await res.text();
  if (!res.ok) {
    // A registry says why in the body, in the shape the spec gives it. Reading
    // it turns "404" into "MANIFEST_UNKNOWN", which is the difference between
    // knowing the tag is gone and knowing only that something went wrong.
    throw new Error(`${repository}:${reference} — ${describe(body) ?? `the registry answered ${res.status}`}`);
  }

  const reported = res.headers.get("Docker-Content-Digest") ?? undefined;
  const { digest, mismatch, note } = await digestOf(body, reported);

  return {
    manifest: JSON.parse(body) as unknown,
    digest,
    mediaType: res.headers.get("Content-Type") ?? "-",
    mismatch,
    digestNote: note,
  };
}

/**
 * The digest of these bytes, computed where that is possible and taken on trust
 * where it is not.
 *
 * `crypto.subtle` exists only in a secure context -- https, or localhost. A
 * page served over plain http from anywhere else does not have it, and a
 * registry UI running on an internal host without TLS is exactly that. So the
 * computation is attempted and its absence is a missing field rather than a
 * failed page: the digest is one line of the answer, and everything else about
 * the image is still worth showing.
 */
async function digestOf(
  body: string,
  reported: string | undefined,
): Promise<{ digest?: string; mismatch?: string; note?: string }> {
  if (globalThis.crypto?.subtle === undefined) {
    return reported === undefined
      ? { note: "no digest: the registry did not expose one and this page cannot compute it over plain http" }
      : { digest: reported, note: "digest as the registry reports it, unverified: computing one needs https" };
  }

  const digest = await sha256(body);
  return { digest, mismatch: reported !== undefined && reported !== digest ? reported : undefined };
}

/**
 * A blob, parsed as JSON.
 *
 * Always by digest, so always cacheable: an image config or a signature bundle
 * read twice is fetched once.
 *
 * The client leaves a blob's body unread on purpose, so the response is what
 * there is to read -- `unwrap()` answers the empty value beside it, and is
 * called only to turn an error response into a throw.
 */
export async function readBlob(client: RegistryClient, repository: string, digest: string): Promise<unknown> {
  return await cache.get(`${client.domain}/${repository}/blobs@${digest}`, async () => {
    const res = await client.repo(repository).blobs.get(digest);
    res.unwrap();

    return await res.raw.json();
  });
}

/** What a registry's error body says, if it is one and it says anything. */
function describe(body: string): string | undefined {
  try {
    const errors = (JSON.parse(body) as { errors?: { code?: string; message?: string }[] }).errors;
    const said = (errors ?? [])
      .map((error) => error.message ?? error.code)
      .filter((text): text is string => typeof text === "string" && text !== "");
    return said.length > 0 ? said.join("; ") : undefined;
  } catch {
    return undefined;
  }
}

/** `sha256:<hex>`, over the exact bytes. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
