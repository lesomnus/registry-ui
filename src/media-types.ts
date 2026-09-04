import { vnd } from "@lesomnus/oci-client/media-types";

/**
 * Docker's manifest media types, which oci-client does not name.
 *
 * A registry still holding images pushed by an older client answers with these,
 * and a browser that only says it understands OCI is told the manifest does not
 * exist -- content negotiation applies to `HEAD` the same way, so it looks like
 * a missing tag rather than a refused one.
 */
export const docker = {
  indexV2: "application/vnd.docker.distribution.manifest.list.v2+json",
  manifestV2: "application/vnd.docker.distribution.manifest.v2+json",
} as const;

/** Everything this page can read a manifest as, in the order it prefers them. */
export const manifestMediaTypes = [
  vnd.oci.image.indexV1,
  vnd.oci.image.manifestV1,
  docker.indexV2,
  docker.manifestV2,
];

/** The types that mean "this holds other manifests" rather than "this is an image". */
export const indexMediaTypes = new Set<string>([vnd.oci.image.indexV1, docker.indexV2]);
