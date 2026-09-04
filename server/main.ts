/**
 * Serves the page, and forwards what the page cannot fetch itself.
 *
 * A registry answers `fetch` from a browser only if it sends
 * `Access-Control-Allow-Origin`. zot does; Docker Hub and GHCR do not. So the
 * page asks here and this asks the registry.
 *
 * # It holds no credentials
 *
 * Whatever the page put in `Authorization` is passed along and nothing is added.
 * This process has no configuration, no secret and no idea which registry it is
 * talking to until a request tells it -- so running it grants nobody access to
 * anything they did not already have credentials for.
 *
 * # It is a forwarder, which is a thing to be careful with
 *
 * Anything that can reach this can ask it to fetch a URL, and "a URL" includes
 * ones only this host can reach. That is server-side request forgery, and the
 * limits below are what keeps it from being useful for it:
 *
 *   - GET and HEAD only, so nothing can be changed through it
 *   - http and https only
 *   - private, loopback and link-local addresses are refused unless
 *     ALLOW_PRIVATE_TARGETS is set, which is what you set to browse a registry
 *     on your own machine
 *   - responses over MAX_BODY_BYTES are refused before the body is read
 *
 * The refusal is by literal address: a name that resolves to a private address
 * is not caught here, and a determined caller can arrange that. Do not put this
 * on the public internet.
 */

import { file } from "bun";

const port = Number(process.env["PORT"] ?? 8080);
const allowPrivateTargets = process.env["ALLOW_PRIVATE_TARGETS"] === "true";

/**
 * Who may call this from a browser.
 *
 * The page does not have to be served from here -- a static build on a plain
 * file server is the smaller deployment, and then the forwarder is a different
 * origin. `*` is the default and is not the hole it looks like: this holds no
 * credentials, so allowing any page to call it grants that page nothing it
 * could not get by running the same request itself. What it must not do is
 * allow *cookies*, and it does not: `Access-Control-Allow-Credentials` is never
 * sent, so a browser refuses to attach any.
 */
const allowedOrigin = process.env["ALLOWED_ORIGIN"] ?? "*";

/** A manifest or a signature bundle is kilobytes. A layer is not, and is never wanted here. */
const maximumBodyBytes = Number(process.env["MAX_BODY_BYTES"] ?? 8 * 1024 * 1024);

/** Headers worth carrying back: what the body is, how big, and what it is called. */
const passThrough = [
  "content-type",
  "content-length",
  "docker-content-digest",
  "link",
  "www-authenticate",
  "oci-filters-applied",
];

const staticFiles: Record<string, { path: string; type: string }> = {
  "/": { path: `${import.meta.dir}/../dist/index.html`, type: "text/html; charset=utf-8" },
};

const privatePatterns = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fd/i,
  /^fe80:/i,
];

/** Whether the host is a literal address in a range that is not the caller's to reach. */
function isPrivateAddress(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (bare === "localhost") {
    return true;
  }

  return privatePatterns.some((pattern) => pattern.test(bare));
}

/**
 * The CORS headers every answer from the forwarder carries.
 *
 * `Access-Control-Expose-Headers` is the one that is easy to leave out and
 * expensive to leave out: without it a browser hands the page a response whose
 * `Docker-Content-Digest` and `Link` read as absent. Nothing errors -- pages
 * just paginate once and report a digest of "-", which looks like a registry
 * that does not send them.
 */
function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "authorization, accept, range",
    "access-control-expose-headers": passThrough.join(", "),
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

function refuse(status: number, message: string): Response {
  return new Response(JSON.stringify({ errors: [{ code: "FORWARDER", message, detail: null }] }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

async function forward(request: Request, raw: string): Promise<Response> {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return refuse(400, "url is not a URL");
  }

  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return refuse(400, `${target.protocol} is not forwarded`);
  }

  if (!allowPrivateTargets && isPrivateAddress(target.hostname)) {
    return refuse(403, "that address is not forwarded; set ALLOW_PRIVATE_TARGETS=true to reach your own network");
  }

  const headers = new Headers();
  for (const name of ["authorization", "accept", "range"]) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: request.method, headers, redirect: "follow" });
  } catch (err) {
    return refuse(502, `could not reach ${target.host}: ${(err as Error).message}`);
  }

  const declared = Number(upstream.headers.get("content-length") ?? "0");
  if (declared > maximumBodyBytes) {
    upstream.body?.cancel();
    return refuse(413, `${declared} bytes is more than this forwards`);
  }

  const out = new Headers(corsHeaders());
  for (const name of passThrough) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      out.set(name, value);
    }
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/-/fetch") {
      // The page sends Authorization, which is not a simple header, so a
      // cross-origin call arrives as a preflight first.
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return refuse(405, "only GET and HEAD are forwarded");
      }

      const target = url.searchParams.get("url");
      if (target === null) {
        return refuse(400, "no url to fetch");
      }

      return await forward(request, target);
    }

    if (url.pathname === "/-/health") {
      return new Response("ok\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    const asset = staticFiles[url.pathname];
    if (asset !== undefined) {
      return new Response(file(asset.path), { headers: { "content-type": asset.type } });
    }

    // Everything vite built. The names are hashed, so serving the directory is
    // serving exactly what index.html asks for.
    const built = file(`${import.meta.dir}/../dist${url.pathname}`);
    if (await built.exists()) {
      return new Response(built);
    }

    return refuse(404, "not found");
  },
});

console.log(`registry-ui on http://localhost:${server.port}`);
if (allowPrivateTargets) {
  console.log("forwarding to private addresses is enabled");
}
