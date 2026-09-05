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
 *
 * That is now the only reason. It was also the way around the 196-byte `Accept`
 * that `get()` attaches, which a browser will not send to a registry that does
 * not allow the header -- but oci-client 1.0.1 lets a caller choose, and what
 * to choose turned out not to be "nothing". The choice is made once per
 * connection, as a transport middleware, so it reaches these requests too. See
 * media-types.ts for the measurements and registry.ts for the choice.
 *
 * **Every manifest read goes through here**, including the ones behind
 * `openArtifact`, or that comes back.
 */

export type ReadManifest = {
  manifest: unknown;
  /** The bytes as they arrived, which is what the digest is over. */
  body: string;
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

async function fetchManifest(client: RegistryClient, repository: string, reference: string): Promise<ReadManifest> {
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
    body,
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

/**
 * How much of a blob this page will hold in order to show it.
 *
 * A layer is allowed to be a gigabyte. Reading one into a string to put in a
 * `<pre>` is a way to lose the tab, so above this the blob is offered as a
 * download and not as a view. It also bounds what the cache below can hold:
 * a text blob is remembered by digest like everything else, and 500 entries
 * of this is a number that fits in a browser.
 */
export const viewableBytes = 1024 * 1024;

/**
 * A blob as text, for showing.
 *
 * Refuses before reading rather than after: `Content-Length` is asked first, so
 * a layer too big to show costs a `HEAD`-shaped answer and not a download. A
 * registry that declares no length is read anyway and cut off at the limit --
 * a truncated view says so, which beats refusing something that would have fit.
 */
export async function readBlobText(
  client: RegistryClient,
  repository: string,
  digest: string,
): Promise<{ text: string; truncated: boolean }> {
  return await cache.get(`${client.domain}/${repository}/text@${digest}`, async () => {
    const res = await client.repo(repository).blobs.get(digest);
    res.unwrap();

    const declared = Number(res.raw.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > viewableBytes) {
      throw new Error(`${formatBytes(declared)} is more than this page will read to show it`);
    }

    const text = await res.raw.text();
    return text.length > viewableBytes
      ? { text: text.slice(0, viewableBytes), truncated: true }
      : { text, truncated: false };
  });
}

/**
 * A blob as bytes, to hand to the browser as a file.
 *
 * Not cached, unlike everything else read by digest. The others are kilobytes
 * kept because they will be asked for again; this is however large the layer
 * is, wanted once, and holding it after the download would be holding it for
 * nothing.
 */
export async function readBlobBytes(client: RegistryClient, repository: string, digest: string): Promise<Blob> {
  const res = await client.repo(repository).blobs.get(digest);
  res.unwrap();

  return await res.raw.blob();
}

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${Math.round(bytes / 1024)} KiB`;

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
