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

Or as containers:

```bash
docker compose up --build     # page on :8080, forwarder on :8081
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

## Containers

Two images, because they are two different things.

**`Dockerfile`** builds the page and serves it with
[static-web-server](https://static-web-server.net) — about 12 MB, no runtime,
compression and ETag and a health endpoint for free. It is only the page: SWS
does not reverse proxy and
[is not going to](https://github.com/static-web-server/static-web-server/issues/489),
so the forwarder is not in it.

**`Dockerfile.forwarder`** is the forwarder, for registries that do not send
CORS headers.

### Pointing the page at a registry

A static build has no configuration of its own, so the container writes one at
startup from its environment and the page fetches it on load:

```bash
docker run -p 8080:8080 -e REGISTRY_DOMAIN=registry.example registry-ui
```

| Variable             |                                                         |
| -------------------- | ------------------------------------------------------- |
| `REGISTRY_DOMAIN`    | e.g. `registry.example`, `localhost:5000`               |
| `REGISTRY_FORWARDER` | where the forwarder is, if it is not this origin        |
| `REGISTRY_INSECURE`  | `true` for a registry with no TLS                       |
| `REGISTRY_DIRECT`    | `true` for a registry that sends CORS headers           |

Set a domain and the page opens it by itself rather than asking somebody to
press a button that was already filled in for them.

These are **defaults**. Someone who types a different registry has that
remembered in their browser, which also means changing the variable does not
move somebody who has already typed one — they clear the field or their site
data. That is the trade for the field being editable at all.

**There is no variable for a password.** A credential in a container's
environment is a credential in `docker inspect`, in the orchestrator's API and
in anything that reads either. The page asks for one.

Against a registry that *does* send them — zot, or anything behind an ingress
that adds them — run the page alone and tick **direct**. There is then nothing
else to deploy and nothing that can be asked to fetch a URL.

Otherwise run both. The page is a different origin from the forwarder, so the
forwarder sends CORS headers and `ALLOWED_ORIGIN` says who may call it. The
forwarder's URL is typed into the page, which keeps the image free of runtime
configuration: the same static build works wherever it is served from, including
somewhere that is not a server at all.

### GitHub Pages, or any static host

The build is relative — assets are referenced as `./assets/…` — so it works at
the root of a host, in a subdirectory, or on a Pages project site at
`/<repo>/`. `.github/workflows/pages.yaml` publishes it.

Two things do not come with it:

- **No forwarder.** Pages serves files and runs nothing. So either the registry
  sends CORS headers and you tick **direct**, or you point the page at a
  forwarder you run somewhere.
- **No `config.json` from the environment**, since there is no container to
  write one. Commit one next to `index.html` if the deployment should start
  somewhere; without one the form opens empty, which is the right default for a
  page anybody can load.

And one thing to know: **Pages is HTTPS, so whatever the page talks to must be
too.** A browser refuses an `http://` registry or forwarder from an `https://`
page as mixed content, which rules out the **http** tick and a registry on your
own machine.

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
| `ALLOWED_ORIGIN`        | Who may call it from a browser. Default `*`.                    |

`*` is not the hole it looks like: the forwarder holds no credentials, so
allowing any page to call it grants that page nothing it could not get by making
the request itself. It never sends `Access-Control-Allow-Credentials`, so a
browser will not attach cookies to it either. Naming the page is still tighter.

It answers preflights, and it lists what a page may read back in
`Access-Control-Expose-Headers` — without that a browser hands the page a
response whose `Docker-Content-Digest` and `Link` read as absent, and nothing
errors: pages just stop paginating and digests come out as `-`.

### What a browser is allowed to read

CORS hides every response header except a short safelist unless the registry
sends `Access-Control-Expose-Headers`, and most do not — zot sends
`Docker-Content-Digest` and `Link` and exposes neither. In **direct** mode a
page is therefore told less than the registry said. Two consequences, both
handled rather than reported:

- **The digest is computed**, not read. It is the SHA-256 of the manifest bytes
  and the bytes are right here, so trusting a header was never necessary. When
  the header *is* readable it is checked, and a registry naming a digest its own
  bytes do not have is said out loud.
- **Paging falls back to the last name returned** when `Link` cannot be read,
  which is what the spec says to send back anyway. A page that adds nothing new
  ends the walk, so a registry whose cursor is not a name stops rather than
  looping.

Through the forwarder both headers are readable — it exposes them — so this only
bites in direct mode, and it does not bite.

**direct** is on unless a deployment says otherwise: a page on a plain file
server has no forwarder to reach, so talking to the registry from the browser is
the only thing that can work there. It is also the better arrangement when it
works at all -- nothing but the page ever sees the credentials.

A deployment that does have a forwarder says so. The bundled server answers
`/config.json` with `direct: false`; the container image does the same when
given `REGISTRY_DIRECT=false`.

## Two views of the same names

Repository names are paths — `dist/hday/kamino`, `dist/hday/lens` — and a flat
list of a few hundred of them hides what the shared prefixes mean. **tree**
draws them once. A run of single-child groups is folded into one row, so
`dist/external/docker.io/library` is one line rather than four clicks.

**Switching keeps your place.** The row at the top of the viewport is put back
under the same pixel: going to the tree opens whatever groups have to be open
for it to exist, and coming back from a group row — which is not in the flat
list at all — the first repository under it stands in. Expanding a group holds
the group exactly where it is on screen rather than the top row, since that is
the thing being looked at.

## Filtering, and asking the registry

Typing filters what is already loaded, instantly, and picks the matching text
out of every name — every occurrence, since a name is a path and the same word
often appears in more than one segment.

Behind that, the registry is asked too. Searching is not in the distribution
spec, so there is no one endpoint: zot serves GraphQL, Docker Hub and friends
serve `/v1/search`, and plenty serve neither. oci-client has both shapes behind
one interface; which one a registry answers is found out by trying, once, and
remembered — including "neither", so a registry that cannot search is not asked
again on every keystroke.

Results the local list does not have are marked **found** and **appended**
rather than merged in by rank. What is already on screen stays where it is: an
answer arriving must not move what somebody is reading.

This matters most where there is no list at all. Docker Hub serves no
`_catalog`, so browsing it is search or nothing.

## Long lists

Both listings are paged to the end — `_catalog` and `tags/list` alike. Asking
for a large `n` is not the same as asking for all of them: a registry may answer
with fewer and say where the rest are, and taking what comes back drops the
remainder without saying so.

The repository list is **drawn as the pages arrive** rather than after the last
one, so a registry with a hundred pages shows the first immediately. Each redraw
holds the scroll position, so a list growing underneath you does not move what
you are reading — new names arrive below, which is where they belong.

It is not infinite scroll: the pages are fetched as fast as the registry answers
rather than when you reach the bottom. The scrollbar is honest about what has
arrived, and grows.

The lists then only build the rows you can see. A registry with fifty thousand
tags would otherwise be fifty thousand elements to lay out and keep, paid again
on every filter and every selection; it builds about two dozen instead, and
replaces them as you scroll. The scroller is sized as though they were all
there, so the scrollbar and `Home` and `End` behave.

`rowHeight` in `src/render/list.ts` and the row height in the stylesheet have to
agree — the window is positioned by multiplying it.

## How it talks to a registry

Through [`@lesomnus/oci-client`](https://github.com/lesomnus/oci-client), which
implements the distribution API for the browser.

The useful seam is `Transport`. Token authentication sends a client to a
*second* host — the `realm` in the `WWW-Authenticate` challenge — and
oci-client asks for that token through the same transport chain. So one
transport underneath its authorizer catches the registry and the token endpoint
both, and neither of them knows it is being forwarded. A URL prefix applied
where the registry URL is built would catch only the first.

Credentials go to the authorizer rather than onto every request, which is not a
detail: it waits for the challenge, answers `basic` by sending the credential
and `bearer` by spending it at the token endpoint the challenge names, and
remembers the result. Attaching them to every request instead would send them to
hosts that never asked, the token endpoint among them, which wants them
somewhere else.

A registry with no referrers API is handled inside the client, by the referrers
tag schema. This page does not know which kind it is talking to.

Manifest requests say what they can read — OCI and Docker, index and manifest.
Without that a registry answers with whatever it prefers, or with a `404` for a
manifest it cannot put in a form the caller claimed to understand, which looks
like a missing tag rather than a refused one.

Tick **http** for a registry with no TLS, which is most of them on your own
machine. The scheme is rewritten on the way out, so nothing above has to know.

One thing worth knowing when reading the code: **blobs are read with
`raw.json()` and manifests are not.** `blobs.get()` leaves the body unread on
purpose; `unwrap()` has already read a manifest, and the result *is* the
manifest, so asking again throws.

## Installing it

oci-client comes from git rather than npm — npm still has 0.0.1 from 2024, and
the credential support, the referrers fallback, the paged catalog, `Accept` and
`Unsecure` this uses are all newer. `npm install` builds it, through the
package's `prepare`.

The dependency is pinned to a commit in `package-lock.json`. When there is a
release on npm this goes back to a version range.

## Layout

```
src/transport.ts     the forwarder as a Transport, and the direct one
src/registry.ts      the client, and the credentials middleware
src/catalog.ts       the repository list, followed to the end
src/certificate.ts   the Fulcio extensions, read out of DER
src/render/          dom helpers, the image view, the artifact renderers
server/main.ts       the page, and the forwarder
```
