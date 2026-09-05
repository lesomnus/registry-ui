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
 * What a manifest request asks for, and why it is not one answer.
 *
 * Naming the four manifest types a page can read comes to 196 bytes, and a
 * request header over **128** is not CORS-safelisted -- so it turns every
 * manifest request into a preflight, and the preflight then has to be allowed
 * to carry `accept`. zot allows `Authorization`, `content-type` and its own
 * header, and not that one, so browsing a zot registry directly from a page
 * failed on every manifest with:
 *
 *   Request header field accept is not allowed by Access-Control-Allow-Headers
 *
 * This file used to say the header bought nothing -- that a registry returns
 * what it has, measured against Docker Hub and zot. That generalised two
 * registries into all of them, and it is false. A registry is allowed to answer
 * `404` for a manifest it cannot represent as something you said you would
 * take, and some do:
 *
 *   Accept                 ghcr.io   registry.k8s.io   Docker Hub   zot
 *   nothing                  404          200             200       200
 *   the two OCI types         200          404             200       200
 *   all four (196 bytes)      200          200             200       200
 *
 * Nothing under 128 bytes reads both `ghcr.io` and `registry.k8s.io`: the
 * limit fits two types and no pair is right everywhere, the shortest correct
 * subset being three of them. So the choice is made per connection rather than
 * once, in registry.ts:
 *
 * - **Through the forwarder**, the full list. The forwarder allows `accept` in
 *   its preflight, so the 196 bytes cost a preflight and nothing else -- and
 *   the registries that need them are exactly the ones only reachable this way.
 * - **Direct from the page**, nothing, and `fetch` supplies its own `*​/*`. It
 *   is the only choice that stays safelisted while still reading a registry
 *   that holds Docker types. What it gives up is `ghcr.io`, which sends no
 *   CORS headers at all and so is not reachable directly whatever is sent.
 *
 * Measured 2026-09-05 against those four registries, and by
 * lesomnus/oci-client#3 against `quay.io` and `mcr.microsoft.com` as well.
 */

/** The types that mean "this holds other manifests" rather than "this is an image". */
export const indexMediaTypes = new Set<string>([vnd.oci.image.indexV1, vnd.docker.distribution.manifestListV2]);
