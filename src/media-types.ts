import { vnd } from "@lesomnus/oci-client/media-types";

/**
 * The sigstore bundle, which oci-client does not name.
 *
 * It names what cosign attaches under `vnd.dev.cosign`, and this is the newer
 * shape -- a DSSE envelope with its verification material, written by
 * `cosign sign` since v2.
 */
export const sigstoreBundle = {
  v03: "application/vnd.dev.sigstore.bundle.v0.3+json",
  any: "application/vnd.dev.sigstore.bundle+json",
} as const;

/**
 * Why manifest requests send no `Accept`.
 *
 * Naming the four types a page can read comes to 196 bytes, and a request
 * header over **128** is not CORS-safelisted -- so it turns every manifest
 * request into a preflight, and the preflight then has to be allowed to carry
 * `accept`. zot allows `Authorization`, `content-type` and its own header, and
 * not that one, so browsing a zot registry directly from a page failed on every
 * manifest with:
 *
 *   Request header field accept is not allowed by Access-Control-Allow-Headers
 *
 * The header was buying nothing. Measured against Docker Hub and zot, over a
 * modern index, a Docker manifest list and a schema1 image: every registry
 * answered with the same media type whether it was sent the full list, the two
 * OCI types, `*​/*`, or nothing at all. A registry returns what it has.
 *
 * So nothing is sent, `fetch` supplies its own `*​/*`, no request is preflighted
 * for a header, and the four types below stay for reading the answer rather
 * than for asking the question.
 */

/** The types that mean "this holds other manifests" rather than "this is an image". */
export const indexMediaTypes = new Set<string>([
  vnd.oci.image.indexV1,
  vnd.docker.distribution.manifestListV2,
]);
