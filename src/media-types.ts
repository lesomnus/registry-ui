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

/** Everything this page can read a manifest as, in the order it prefers them. */
export const manifestMediaTypes = [
  vnd.oci.image.indexV1,
  vnd.oci.image.manifestV1,
  vnd.docker.distribution.manifestListV2,
  vnd.docker.distribution.manifestV2,
];

/** The types that mean "this holds other manifests" rather than "this is an image". */
export const indexMediaTypes = new Set<string>([
  vnd.oci.image.indexV1,
  vnd.docker.distribution.manifestListV2,
]);
