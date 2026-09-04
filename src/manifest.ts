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
  digest: string;
  mediaType: string;
  /** Set when the registry named a digest and it was not the one the bytes have. */
  mismatch?: string;
};

export async function readManifest(
  client: RegistryClient,
  repository: string,
  reference: string,
): Promise<ReadManifest> {
  const url = `https://${client.domain}/v2/${repository}/manifests/${reference}`;
  const res = await client.transport.fetch(url, {
    method: "GET",
    endpoint: { method: "GET", name: repository, resource: "manifests", reference },
  });

  if (!res.ok) {
    throw new Error(`${repository}:${reference} answered ${res.status}`);
  }

  const body = await res.text();
  const digest = await sha256(body);
  const reported = res.headers.get("Docker-Content-Digest") ?? undefined;

  return {
    manifest: JSON.parse(body) as unknown,
    digest,
    mediaType: res.headers.get("Content-Type") ?? "-",
    mismatch: reported !== undefined && reported !== digest ? reported : undefined,
  };
}

/** `sha256:<hex>`, over the exact bytes. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
