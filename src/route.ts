/**
 * The address bar, as an image reference.
 *
 * The fragment is not a made-up route language: it is `domain/repository:tag`
 * or `domain/repository@sha256:...`, the same string a person would hand to
 * `docker pull`. So a link to what is on screen is readable as the thing it is
 * showing, and the part after the `#` can be pasted straight into a pull.
 *
 * It is a fragment rather than a path on purpose. This is built to be served by
 * anything that serves files -- GitHub Pages, static-web-server, an S3 bucket
 * -- and a path route needs the server to answer every path with `index.html`.
 * A fragment needs nothing: it never reaches the server, and the same build
 * works under any base path, which is also why `vite.config.ts` builds relative
 * asset URLs.
 *
 * Where a `docker pull` reference and this one differ, both times because there
 * is no daemon here to make something up: no domain means whatever registry the
 * page is already connected to rather than Docker Hub, and no tag means the
 * repository with nothing opened rather than `latest`.
 */
export type Route = {
  domain?: string;
  repository?: string;
  /** A tag, or a `sha256:...`; whichever the reference named. */
  reference?: string;
};

/**
 * Whether the first segment names a registry rather than the first part of a
 * repository name.
 *
 * A dot, a colon, or the word `localhost` -- the rule every container tool
 * uses, so a reference here means what it means everywhere else. It is a
 * heuristic there, too: a repository whose first segment contains a dot is
 * legal and would be read as a host. Nothing this page writes is ambiguous,
 * because it always writes the domain; the rule is for what somebody types.
 */
const isDomain = (segment: string): boolean =>
  segment === "localhost" || segment.includes(".") || segment.includes(":");

export function parseRoute(hash: string): Route {
  let text: string;
  try {
    text = decodeURIComponent(hash.replace(/^#/, "")).trim();
  } catch {
    // A fragment that is not valid percent-encoding is one nobody wrote.
    text = "";
  }

  if (text === "" || text === "/") {
    return {};
  }

  // The digest is looked for first: it contains a colon of its own, which would
  // otherwise read as the start of a tag.
  let name = text;
  let reference: string | undefined;
  const at = text.indexOf("@");
  if (at >= 0) {
    name = text.slice(0, at);
    reference = text.slice(at + 1);
  } else {
    const colon = text.lastIndexOf(":");
    if (colon > text.lastIndexOf("/")) {
      name = text.slice(0, colon);
      reference = text.slice(colon + 1);
    }
  }

  // `registry.example/` is a registry with nothing opened. Without the slash it
  // is one segment, which is a repository -- the trailing slash is the only
  // thing separating the two, so it is read before the empties are dropped.
  const bare = name.endsWith("/");
  const segments = name.split("/").filter((segment) => segment !== "");
  const first = segments[0];
  const named = first !== undefined && (segments.length > 1 || bare) && isDomain(first);
  const domain = named ? segments.shift() : undefined;

  return {
    domain,
    repository: segments.join("/") || undefined,
    reference: reference === "" ? undefined : reference,
  };
}

export function formatRoute({ domain, repository, reference }: Route): string {
  if (!repository) {
    return domain ? `#${domain}/` : "#";
  }

  const name = domain ? `${domain}/${repository}` : repository;
  if (!reference) {
    return `#${name}`;
  }

  return `#${name}${reference.includes(":") ? "@" : ":"}${reference}`;
}
