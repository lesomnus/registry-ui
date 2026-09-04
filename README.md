# registry-ui

A browser for an OCI registry: which repositories it holds, which tags each one
has, what is inside a tag, and **what is attached to it** — signatures,
attestations, SBOMs.

Point it at any registry. It reads and never writes.

```bash
npm install
npm run build
npm run serve        # http://localhost:8080
```

Then type a registry: `registry.example`, `index.docker.io`, `localhost:5000`.
Credentials are optional and are used only if the registry asks for them.

## What it shows

Most registry browsers stop at "here are your tags". The part worth having is
the last column: an image is a thing you are about to run, and whether it is
signed — and by whom — is the first question, not a detail.

So a tag opens onto its digest, its platforms, its layers, and a table of
everything attached to it. **The type picks the renderer.** A sigstore signature
is keyless, so its identity is not a key somebody holds but the workflow that
asked for the certificate, and that is what you see:

```
Signed by    https://github.com/org/repo/.github/workflows/release.yml@refs/heads/main
Issuer       https://token.actions.githubusercontent.com
Repository   https://github.com/org/repo        Ref  refs/heads/main
Commit       525c8f24ae48                       Runner  self-hosted
Rekor entry  2670525299                         → Open the run that signed it
```

| Artifact type                                   | Shown as                                             |
| ----------------------------------------------- | ---------------------------------------------------- |
| `application/vnd.dev.sigstore.bundle.v0.3+json` | who signed it, out of the Fulcio certificate         |
| `application/vnd.cncf.notary.signature`         | when, and the certificate chain from the annotations |
| anything else                                   | media type, subject, annotations, layers             |

Adding a renderer is adding an entry to `artifactRenderers` in
`src/render/artifact.ts`. An index is already a renderer in this sense — it is
drawn as a platform table rather than as the JSON it is.

**Nothing here verifies anything.** The certificate is read, not checked: not
the chain, not the dates, not the signature. It reports what a signature claims
about itself, and `cosign verify` or `notation verify` is what decides whether
to believe it.

## Why there is a server

A registry answers `fetch` from a page only if it sends
`Access-Control-Allow-Origin`. zot does. Docker Hub and GHCR do not. So
`server/main.ts` forwards what the page cannot fetch itself.

It holds no credentials and has no configuration: whatever the page put in
`Authorization` is passed along, and nothing is added. Running it grants nobody
access to anything they did not already have credentials for.

**It is a forwarder, which is a thing to be careful with.** Anything that can
reach it can ask it to fetch a URL, and "a URL" includes ones only that host can
reach. What keeps it from being useful for server-side request forgery:

- `GET` and `HEAD` only, so nothing can be changed through it
- `http` and `https` only
- private, loopback and link-local addresses are refused
- responses over `MAX_BODY_BYTES` (8 MiB) are refused before the body is read

The refusal is by literal address, so a hostname that *resolves* to a private
address is not caught. **Do not put this on the public internet.**

| Variable                |                                                                 |
| ----------------------- | --------------------------------------------------------------- |
| `PORT`                  | Default `8080`.                                                 |
| `ALLOW_PRIVATE_TARGETS` | `true` to reach a registry on your own network or machine.      |
| `MAX_BODY_BYTES`        | Default 8 MiB.                                                  |

Tick **direct** in the page to skip the forwarder and talk to the registry from
the browser. Correct for a registry that sends CORS headers, and then nothing
but the page ever sees the credentials.

## How it talks to a registry

Through [`@lesomnus/oci-client`](https://github.com/lesomnus/oci-client), which
implements the distribution API for the browser.

The useful seam is `Transport`. Token authentication sends a client to a
*second* host — the `realm` in the `WWW-Authenticate` challenge — and
oci-client asks for that token through the same transport chain. So one
transport underneath its authorizer catches the registry and the token endpoint
both, and neither of them knows it is being forwarded. A URL prefix applied
where the registry URL is built would catch only the first.

Two things the page does not go through the client for:

- **`_catalog`** is paged with `n` and `last` and says where the next page is in
  a `Link` header. oci-client's catalog extension asks for it in one request, so
  `src/catalog.ts` borrows `client.transport` and follows the pages itself —
  which still gets authentication and forwarding for free.
- **Blobs** are read with `raw.json()`, because `blobs.get()` deliberately
  leaves the body unread. Manifests are not: `unwrap()` has already read those,
  and the result *is* the manifest.

## Layout

```
src/transport.ts     the forwarder as a Transport, and the direct one
src/registry.ts      the client, and the credentials middleware
src/catalog.ts       the repository list, followed to the end
src/certificate.ts   the Fulcio extensions, read out of DER
src/render/          dom helpers, the image view, the artifact renderers
server/main.ts       the page, and the forwarder
```
