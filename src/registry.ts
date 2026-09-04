import { ClientV2, TransportAuthorizer, ext } from "@lesomnus/oci-client";
import type { ReqInit, Transport, TransportMiddleware } from "@lesomnus/oci-client";
import { DirectTransport, ProxyTransport } from "./transport";

/** ClientV2, plus `_catalog`, which is not in the distribution spec. */
const Client = ClientV2.with(ext.Catalog());
export type RegistryClient = InstanceType<typeof Client>;

export type Connection = {
  /** Host, and port if it is not the default: `registry.example`, `localhost:5000`. */
  domain: string;
  /** Sent as HTTP Basic. A registry that wants a token takes one here as the password. */
  username?: string;
  password?: string;
  /** Talk to the registry from the page, with no forwarder. See transport.ts. */
  direct?: boolean;
};

/**
 * Adds the credentials the user typed, if they typed any.
 *
 * Basic rather than Bearer, because that is what both kinds of registry
 * understand: one that wants a password, and one that wants a token and reads
 * it out of the password field -- which is how `docker login` sends a token and
 * therefore how every registry has learned to accept one.
 *
 * Skipped when the request already carries an Authorization, so the token the
 * authorizer obtained is not overwritten by the credentials it obtained it with.
 */
class BasicCredentials implements TransportMiddleware {
  private readonly value: string;

  constructor(username: string, password: string) {
    this.value = `Basic ${btoa(`${username}:${password}`)}`;
  }

  async fetch(resource: RequestInfo | URL, init: ReqInit | undefined, next: Transport): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", this.value);
    }

    return await next.fetch(resource, { ...init, headers });
  }
}

/**
 * A client for one registry.
 *
 * The chain is credentials, then the authorizer, then the wire, and the order
 * is the point. The authorizer turns a 401 into a token request, so it has to
 * see the answer to credentials that were already applied: a registry that
 * takes Basic outright never reaches it, and one that answers with a challenge
 * does.
 */
export function connect(connection: Connection): RegistryClient {
  const wire = connection.direct ? new DirectTransport() : new ProxyTransport();
  const authorizer = new TransportAuthorizer();

  return new Client(connection.domain, {
    transport:
      connection.username && connection.password
        ? [new BasicCredentials(connection.username, connection.password), authorizer, wire]
        : [authorizer, wire],
  });
}
