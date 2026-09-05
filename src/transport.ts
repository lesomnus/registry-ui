import type { ReqInit, Transport } from "@lesomnus/oci-client";

/**
 * Getting a browser to a registry that was not expecting one.
 *
 * A registry answers `fetch` from a page only if it sends `Access-Control-Allow-Origin`,
 * and most do not: zot does, Docker Hub and GHCR do not. So there is a small
 * forwarder in `server/`, and this sends every request through it.
 *
 * # Why this is a transport and not a URL prefix
 *
 * Token authentication redirects the client to a *second* host -- the `realm`
 * in the `WWW-Authenticate` challenge, `auth.docker.io` for Docker Hub -- and
 * that host needs forwarding for the same reason the registry does. oci-client
 * asks for the token through `next.fetch`, so a transport underneath its
 * authorizer catches the registry and the token endpoint both, without either
 * of them knowing.
 *
 * A prefix applied where the registry URL is built would catch only the first.
 */
export class ProxyTransport implements Transport {
  private readonly endpoint: string;

  /**
   * @param endpoint where the forwarder is. A path when it is served from this
   * origin, which is what the bundled server does; a full URL when the page is
   * a static build somewhere else and the forwarder is its own deployment.
   *
   * The default is this origin, which is right where the page and the forwarder
   * ship together and wrong on a static host -- so a request that lands on
   * nothing says which of the two it is.
   */
  constructor(endpoint = "/-/fetch") {
    this.endpoint = endpoint.replace(/\/+$/, "") || "/-/fetch";
  }

  async fetch(resource: RequestInfo | URL, init?: ReqInit): Promise<Response> {
    const target = resource instanceof Request ? resource.url : resource.toString();
    const res = await fetch(`${this.endpoint}?url=${encodeURIComponent(target)}`, init);

    // A forwarder answers JSON, including when it refuses. Anything else at a
    // 404 is not a forwarder failing -- it is nothing being there, which is
    // what a static host answers for a path it has never heard of. Saying so
    // beats handing a page of HTML to a JSON parser.
    if (res.status === 404 && !(res.headers.get("content-type") ?? "").includes("json")) {
      throw new Error(
        `no forwarder at ${this.endpoint} — tick "direct" to talk to the registry from the page, or give the address of one`,
      );
    }

    return res;
  }
}

/**
 * Talks to the registry from the page, with nothing in between.
 *
 * Correct for a registry that sends CORS headers, and the honest choice when
 * there is one: the page is then the only thing that sees the credentials, and
 * there is nothing to deploy. It fails with an opaque network error when the
 * registry does not, which is why it is not the default.
 */
export class DirectTransport implements Transport {
  fetch(resource: RequestInfo | URL, init?: ReqInit): Promise<Response> {
    return fetch(resource, init);
  }
}
