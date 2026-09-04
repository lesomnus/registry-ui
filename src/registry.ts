import { ClientV2, TransportAuthorizer, ext } from "@lesomnus/oci-client";
import { DirectTransport, ProxyTransport } from "./transport";

/** ClientV2, plus `_catalog`, which is not in the distribution spec. */
const Client = ClientV2.with(ext.Catalog);
export type RegistryClient = InstanceType<typeof Client>;

export type Connection = {
  /** Host, and port if it is not the default: `registry.example`, `localhost:5000`. */
  domain: string;
  /** A registry that wants a token takes one in the password. See below. */
  username?: string;
  password?: string;
  /** Talk to the registry from the page, with no forwarder. See transport.ts. */
  direct?: boolean;
};

/**
 * A client for one registry.
 *
 * The credential goes to the authorizer rather than onto every request. That is
 * what a registry expects and it is not a detail: the authorizer waits for the
 * challenge, answers `basic` by sending the credential and `bearer` by spending
 * it at the token endpoint the challenge names, and remembers the result per
 * challenge. Attaching the credential to every request instead would send it to
 * hosts that never asked, including the token endpoint, which wants it in a
 * different place.
 *
 * A registry that wants a token rather than a password takes one in the
 * password field -- which is how `docker login` sends a token and therefore how
 * every registry has learned to accept one.
 */
export function connect(connection: Connection): RegistryClient {
  const wire = connection.direct ? new DirectTransport() : new ProxyTransport();
  const credential =
    connection.username && connection.password
      ? { username: connection.username, password: connection.password }
      : undefined;

  return new Client(connection.domain, {
    transport: [new TransportAuthorizer({ credential }), wire],
  });
}
