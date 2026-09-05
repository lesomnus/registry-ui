import type { RegistryClient } from "../registry";
import { sbom, vnd } from "@lesomnus/oci-client/media-types";
import { base64ToBytes, readFulcioIdentity } from "../certificate";
import { readBlob, readManifest } from "../manifest";
import { sigstoreBundle } from "../media-types";
import { layersSection, type Layer } from "./blob";
import { definitions, element, externalLink, shortDigest, table } from "./dom";

/** A descriptor as it appears in a referrers listing. */
export type Descriptor = {
  digest: string;
  size?: number;
  mediaType?: string;
  artifactType?: string;
  annotations?: Record<string, string>;
};

type Manifest = {
  mediaType?: string;
  artifactType?: string;
  subject?: { digest?: string };
  layers?: Layer[];
  annotations?: Record<string, string>;
};

/**
 * What an attached artifact is, said in words rather than in media types.
 *
 * The question asked of a registry browser is whether a thing is signed, not
 * which media type says so -- so a sigstore bundle and a notation envelope are
 * both "Signature", with the scheme after it.
 *
 * The strings come from oci-client where it names them, which is everything
 * here except the sigstore bundle.
 */
const artifactNames: Record<string, string> = {
  [sigstoreBundle.v03]: "Signature (sigstore)",
  [sigstoreBundle.any]: "Signature (sigstore)",
  [vnd.dev.cosign.simpleSigningV1]: "Signature (cosign)",
  [vnd.cncf.notary.signature]: "Signature (notation)",
  [vnd.inToto.statement]: "Attestation (in-toto)",
  [vnd.inToto.provenance]: "Attestation (provenance)",
  [vnd.inToto.spdx]: "SBOM (SPDX, in-toto)",
  [sbom.spdx.json]: "SBOM (SPDX)",
  [sbom.cyclonedx.json]: "SBOM (CycloneDX)",
  "application/vnd.docker.attestation.manifest.v1+json": "Attestation (buildkit)",
};

export const typeOf = (descriptor: Descriptor): string => descriptor.artifactType ?? descriptor.mediaType ?? "";

export const artifactName = (descriptor: Descriptor): string =>
  artifactNames[typeOf(descriptor)] ?? typeOf(descriptor) ?? "-";

/** The types this page calls a signature, which is what the badge counts. */
const signatureTypes = new Set<string>([
  sigstoreBundle.v03,
  sigstoreBundle.any,
  vnd.dev.cosign.simpleSigningV1,
  vnd.cncf.notary.signature,
]);

export const isSignature = (descriptor: Descriptor): boolean => signatureTypes.has(typeOf(descriptor));

type Renderer = (client: RegistryClient, repository: string, manifest: Manifest) => Promise<Node> | Node;

/**
 * How each known artifact type is shown when it is opened.
 *
 * A registry browser is already a renderer for one type: it draws an image
 * index as a platform table rather than as the JSON it is. Everything attached
 * deserves the same, so the type picks the renderer and anything unrecognised
 * falls back to what every artifact has -- its annotations and its layers.
 *
 * A renderer may fetch and may be async. It must not be relied on to succeed:
 * `openArtifact` falls back when one throws, because a detail view that fails
 * should cost the detail rather than the page.
 */
export const artifactRenderers: Record<string, Renderer> = {
  [sigstoreBundle.v03]: renderSigstore,
  [sigstoreBundle.any]: renderSigstore,
  [vnd.cncf.notary.signature]: renderNotation,
};

type SigstoreBundle = {
  verificationMaterial?: {
    certificate?: { rawBytes?: string };
    tlogEntries?: { logIndex?: string; integratedTime?: string }[];
  };
};

/**
 * A sigstore signature, read as "who signed this, and from where".
 *
 * It is a keyless signature, so the identity is not a key somebody holds but
 * the workflow that asked for the certificate. That is what the certificate
 * carries and what is worth showing.
 *
 * Nothing here verifies anything; `cosign verify` decides whether to believe it.
 */
async function renderSigstore(client: RegistryClient, repository: string, manifest: Manifest): Promise<Node> {
  const fragment = document.createDocumentFragment();
  const layer = manifest.layers?.[0];
  const bundle = layer ? ((await readBlob(client, repository, layer.digest)) as SigstoreBundle) : undefined;

  const raw = bundle?.verificationMaterial?.certificate?.rawBytes;
  const identity = raw ? readFulcioIdentity(base64ToBytes(raw)) : {};
  const tlog = bundle?.verificationMaterial?.tlogEntries?.[0];
  const signedAt = tlog?.integratedTime ? new Date(Number(tlog.integratedTime) * 1000).toLocaleString() : undefined;

  fragment.append(
    definitions([
      ["Signed by", identity.identity],
      ["Issuer", identity.issuer],
      ["Repository", identity.sourceRepository],
      ["Ref", identity.sourceRef],
      ["Commit", identity.sourceRevision ? shortDigest(identity.sourceRevision) : undefined],
      ["Runner", identity.runnerEnvironment],
      ["Signed at", signedAt],
      ["Rekor entry", tlog?.logIndex],
      ["Predicate", manifest.annotations?.["dev.sigstore.bundle.predicateType"]],
    ]),
  );

  if (identity.runUri) {
    fragment.append(externalLink("Open the run that signed it", identity.runUri));
  }

  return fragment;
}

/**
 * A notation signature, read from what the manifest says about it.
 *
 * The envelope is COSE -- CBOR -- and a parser for it would buy two more
 * fields. The certificate chain is named in the annotations by thumbprint,
 * which is what identifies the signer, so that is what is shown.
 */
function renderNotation(_client: RegistryClient, _repository: string, manifest: Manifest): Node {
  const fragment = document.createDocumentFragment();
  const annotations = manifest.annotations ?? {};

  let chain: unknown;
  try {
    chain = JSON.parse(annotations["io.cncf.notary.x509chain.thumbprint#S256"] ?? "[]");
  } catch {
    chain = [];
  }

  const thumbprints = Array.isArray(chain) ? (chain as string[]) : [];
  fragment.append(
    definitions([
      ["Signed at", annotations["org.opencontainers.image.created"]],
      ["Envelope", manifest.layers?.[0]?.mediaType],
      ["Chain", thumbprints.length ? `${thumbprints.length} certificates` : undefined],
    ]),
  );

  if (thumbprints.length) {
    fragment.append(element("h3", undefined, "Certificate chain"));
    fragment.append(
      table(
        [{ text: "#", numeric: true }, { text: "SHA-256 thumbprint" }],
        thumbprints.map((thumbprint, index) => [
          { text: String(index), numeric: true },
          { text: shortDigest(thumbprint) },
        ]),
      ),
    );
  }

  return fragment;
}

/**
 * What every artifact has, for the types this page does not know.
 *
 * No layers here any more: `openArtifact` puts them under every renderer, so
 * the type-specific ones say what they know and the layers are always there
 * underneath, whether or not anything understood the type.
 */
export function renderUnknown(_client: RegistryClient, _repository: string, manifest: Manifest): Node {
  const fragment = document.createDocumentFragment();
  const annotations = Object.entries(manifest.annotations ?? {});

  fragment.append(
    definitions([
      ["Media type", manifest.mediaType],
      ["Artifact type", manifest.artifactType],
      ["Subject", manifest.subject?.digest ? shortDigest(manifest.subject.digest) : undefined],
    ]),
  );

  if (annotations.length) {
    fragment.append(element("h3", undefined, "Annotations"));
    fragment.append(
      table(
        [{ text: "Key" }, { text: "Value" }],
        annotations.map(([key, value]) => [{ text: key }, { text: String(value) }]),
      ),
    );
  }

  return fragment;
}

/** Opens one attached artifact, with the renderer its type asks for. */
export async function openArtifact(
  client: RegistryClient,
  repository: string,
  descriptor: Descriptor,
  into: HTMLElement,
): Promise<void> {
  into.replaceChildren(element("p", "loading", "Reading..."));

  try {
    // Through readManifest rather than `manifests.get()`, for the reason in
    // manifest.ts: the digest has to be computed over the bytes as they
    // arrived. It also means an artifact opened twice is fetched once.
    const manifest = (await readManifest(client, repository, descriptor.digest)).manifest as Manifest;

    let rendered: Node;
    try {
      rendered = await (artifactRenderers[typeOf(descriptor)] ?? renderUnknown)(client, repository, manifest);
    } catch (error) {
      console.warn("artifact renderer failed", error);
      rendered = renderUnknown(client, repository, manifest);
    }

    const panel = element("div", "panel");
    panel.append(
      element("h3", undefined, artifactName(descriptor)),
      rendered,
      // Under every renderer, not only the fallback. A signature renderer says
      // who signed it; the bundle it said that out of is a layer, and reading
      // it is the difference between being told and looking.
      layersSection(client, repository, manifest.layers ?? [], "Content"),
    );
    into.replaceChildren(panel);
  } catch (error) {
    into.replaceChildren(element("p", "error", String((error as Error).message ?? error)));
  }
}
