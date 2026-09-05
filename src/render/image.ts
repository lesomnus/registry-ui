import { isDigest } from "../cache";
import { indexMediaTypes } from "../media-types";
import type { RegistryClient } from "../registry";
import type { Descriptor } from "./artifact";
import { artifactName, isSignature, openArtifact } from "./artifact";
import type { Cell } from "./dom";
import { readBlob, readManifest } from "../manifest";
import { layersSection, rawPane, type Layer } from "./blob";
import { definitions, element, formatSize, shortDigest, table } from "./dom";

type Child = {
  digest: string;
  mediaType?: string;
  platform?: { os?: string; architecture?: string; variant?: string };
};
type Manifest = {
  manifests?: Child[];
  layers?: Layer[];
  config?: { digest?: string; size?: number };
  /** What an ORAS artifact is, which is the only thing that says so. */
  artifactType?: string;
};
type Config = { os?: string; architecture?: string; created?: string; config?: { Labels?: Record<string, string> } };

/**
 * Buildkit rides its attestations in an index as children with no real
 * platform. `unknown/unknown` is how the spec lets them travel, not a
 * description of anything.
 */
const isAttestation = (child: Child): boolean =>
  child.platform?.os === "unknown" && child.platform?.architecture === "unknown";

function platformName(platform: Child["platform"]): string {
  if (!platform?.os) {
    return "unknown";
  }

  return `${platform.os}/${platform.architecture ?? "?"}${platform.variant ? `/${platform.variant}` : ""}`;
}

/** Layers plus config: what a pull of this image actually transfers. */
function transferSize(manifest: Manifest): number {
  return (manifest.layers ?? []).reduce((total, layer) => total + (layer.size ?? 0), 0) + (manifest.config?.size ?? 0);
}

type Attachment = { descriptor: Descriptor; subjectLabel: string };

async function referrersOf(client: RegistryClient, repository: string, digest: string): Promise<Descriptor[]> {
  try {
    const res = await client.repo(repository).referrers.get(digest);
    return (res.unwrap().manifests ?? []) as Descriptor[];
  } catch {
    // A registry without the referrers API is one that still shows the image.
    return [];
  }
}

/**
 * Says whether the image is signed, above everything else about it.
 *
 * An image with nothing attached says so, rather than saying nothing: the
 * absence of a badge and the absence of a signature should not look the same.
 *
 * "Unsigned" is a verdict on something somebody asked for by name, so it is
 * only said of a tag. A manifest opened by digest -- a platform inside an index
 * -- gets the weaker and truer "nothing attached": cosign signs the index, and
 * calling each platform below a signed image unsigned would be the wrong
 * headline for a true fact.
 */
function signedBadge(attachments: Attachment[], byDigest: boolean): Node {
  const fragment = document.createDocumentFragment();
  const signatures = attachments.filter(({ descriptor }) => isSignature(descriptor));
  if (signatures.length === 0) {
    fragment.append(element("span", "badge-unsigned", byDigest ? "nothing attached" : "unsigned"));
    return fragment;
  }

  const names = [...new Set(signatures.map(({ descriptor }) => artifactName(descriptor)))];
  fragment.append(
    element("span", "badge-signed", signatures.length === 1 ? "signed" : `signed ×${signatures.length}`),
    element("span", "meta", names.join(", ")),
  );

  return fragment;
}

function attachedSection(
  client: RegistryClient,
  repository: string,
  attachments: Attachment[],
  showSubject: boolean,
): Node {
  const fragment = document.createDocumentFragment();
  fragment.append(element("h3", undefined, "Attached"));

  if (attachments.length === 0) {
    fragment.append(element("p", "empty", "Nothing is attached to this image."));
    return fragment;
  }

  const detail = element("div", "artifact-detail");
  const headers = showSubject
    ? [{ text: "Type" }, { text: "Attached to" }, { text: "Digest" }, { text: "Size", numeric: true }]
    : [{ text: "Type" }, { text: "Digest" }, { text: "Size", numeric: true }];

  const rows: Cell[][] = attachments.map(({ descriptor, subjectLabel }) => {
    // The type is the handle: clicking it opens whatever renderer knows about
    // that type, which is the point of naming the type in the first place.
    const open = element("button", "linklike", artifactName(descriptor));
    open.addEventListener("click", () => void openArtifact(client, repository, descriptor, detail));

    const cells: Cell[] = [{ text: "", node: open }];
    if (showSubject) {
      cells.push({ text: subjectLabel });
    }

    cells.push({ text: shortDigest(descriptor.digest) }, { text: formatSize(descriptor.size), numeric: true });
    return cells;
  });

  fragment.append(table(headers, rows), detail);
  return fragment;
}

/**
 * The manifest as it arrived, behind a toggle.
 *
 * Everything above it is this page's reading of the manifest, and a reading
 * leaves things out -- an annotation nothing renders, a field from a spec this
 * page has not heard of. Last, and closed, because it is what you open when the
 * rendered answer did not have what you came for.
 *
 * The bytes are the ones the digest was computed over, so this is also the only
 * place that shows exactly what was hashed.
 */
function manifestSection(body: string, mediaType: string): Node {
  const fragment = document.createDocumentFragment();
  const heading = element("h3", undefined, "Manifest");
  const toggle = element("button", "linklike", "show");
  heading.append(" ", toggle);

  const pane = element("div", "artifact-detail");
  toggle.addEventListener("click", () => {
    if (pane.hasChildNodes()) {
      pane.replaceChildren();
      toggle.textContent = "show";
      return;
    }

    pane.append(rawPane(body, mediaType));
    toggle.textContent = "hide";
  });

  fragment.append(heading, pane);
  return fragment;
}

/**
 * Everything this page has to say about one reference.
 *
 * The reference is a tag or a digest, and nothing below cares which: an index
 * opened by tag and a manifest opened by the digest the index named are the
 * same read. That is what makes a child of an index openable -- `open` is
 * called with the child's digest and the caller comes back here with it.
 */
export async function renderImage(
  client: RegistryClient,
  repository: string,
  reference: string,
  open: (digest: string) => void,
): Promise<Node> {
  // `unwrap()` has already read the body, and the result *is* the manifest with
  // `raw` and `as()` laid over it. Asking `raw.json()` again throws.
  // Read for its bytes, so the digest is computed rather than taken on trust --
  // a browser usually cannot read `Docker-Content-Digest` at all. See manifest.ts.
  const read = await readManifest(client, repository, reference);
  const { digest, mediaType, mismatch, digestNote } = read;
  const manifest = read.manifest as Manifest;

  const fragment = document.createDocumentFragment();
  const badge = element("div", "signed");
  fragment.append(badge);

  // The registry named a digest its own bytes do not have. Not this page's
  // problem to solve, and very much its problem to mention.
  if (mismatch !== undefined) {
    fragment.append(
      element(
        "p",
        "error",
        `the registry reports ${shortDigest(mismatch)} for these bytes, which hash to ${shortDigest(digest)}`,
      ),
    );
  }

  if (digestNote !== undefined) {
    fragment.append(element("p", "empty", digestNote));
  }

  if (indexMediaTypes.has(mediaType)) {
    const children = manifest.manifests ?? [];
    fragment.append(
      definitions([
        ["Digest", digest],
        ["Media type", mediaType],
        ["Platforms", children.length],
      ]),
    );

    // The index carries the size of each child manifest, which is a few
    // kilobytes of JSON and not what anyone means by how big an image is.
    const resolved = await Promise.all(
      children.map(async (child) => {
        try {
          const body = (await readManifest(client, repository, child.digest)).manifest as Manifest;
          return { child, size: transferSize(body), layers: (body.layers ?? []).length };
        } catch {
          return { child, size: undefined, layers: undefined };
        }
      }),
    );

    fragment.append(element("h3", undefined, "Platforms"));
    fragment.append(
      table(
        [{ text: "Platform" }, { text: "Digest" }, { text: "Layers", numeric: true }, { text: "Size", numeric: true }],
        resolved.map(({ child, size, layers }) => {
          // The platform is the handle, the way the type is in Attached: what
          // is behind it is a manifest of its own, with its own layers and its
          // own config, and this table has room for neither.
          const label = isAttestation(child) ? "attestation" : platformName(child.platform);
          const handle = element("button", "linklike", label);
          handle.title = `Open ${label}`;
          handle.addEventListener("click", () => open(child.digest));

          return [
            { text: label, node: handle },
            { text: shortDigest(child.digest) },
            { text: layers === undefined ? "-" : String(layers), numeric: true },
            { text: size === undefined ? "-" : formatSize(size), numeric: true },
          ];
        }),
      ),
    );

    // An index can be signed at the index and again at each platform below it.
    // Asking only the index would call a per-platform-signed image unsigned.
    // Referrers hang off a digest; without one there is nothing to ask about.
    const subjects = (digest === undefined ? [] : [{ digest, label: "index" }]).concat(
      children.map((child) => ({
        digest: child.digest,
        label: isAttestation(child) ? "attestation" : platformName(child.platform),
      })),
    );

    const attachments = (
      await Promise.all(
        subjects.map(async ({ digest: subject, label }) =>
          (await referrersOf(client, repository, subject)).map((descriptor) => ({ descriptor, subjectLabel: label })),
        ),
      )
    ).flat();

    badge.replaceChildren(signedBadge(attachments, isDigest(reference)));
    fragment.append(attachedSection(client, repository, attachments, true));
    fragment.append(manifestSection(read.body, mediaType));
    return fragment;
  }

  let config: Config | undefined;
  if (manifest.config?.digest) {
    try {
      config = (await readBlob(client, repository, manifest.config.digest)) as Config;
    } catch {
      config = undefined;
    }
  }

  fragment.append(
    definitions([
      ["Digest", digest],
      ["Media type", mediaType],
      // An artifact pushed by `oras` is an image manifest whose media type says
      // nothing about it. This is the field that does.
      ["Artifact type", manifest.artifactType],
      ["Platform", config?.os ? `${config.os}/${config.architecture ?? "?"}` : undefined],
      ["Created", config?.created ? new Date(config.created).toLocaleString() : undefined],
      ["Size", formatSize(transferSize(manifest))],
      ["Layers", (manifest.layers ?? []).length],
    ]),
  );

  const labels = Object.entries(config?.config?.Labels ?? {});
  if (labels.length) {
    fragment.append(element("h3", undefined, "Labels"));
    fragment.append(
      table(
        [{ text: "Key" }, { text: "Value" }],
        labels.map(([key, value]) => [{ text: key }, { text: String(value) }]),
      ),
    );
  }

  fragment.append(layersSection(client, repository, manifest.layers ?? []));

  const attachments =
    digest === undefined
      ? []
      : (await referrersOf(client, repository, digest)).map((descriptor) => ({
          descriptor,
          subjectLabel: "image",
        }));

  badge.replaceChildren(signedBadge(attachments, isDigest(reference)));
  fragment.append(attachedSection(client, repository, attachments, false));
  fragment.append(manifestSection(read.body, mediaType));
  return fragment;
}
