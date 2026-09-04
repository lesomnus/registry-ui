/**
 * Reading the few things a Fulcio certificate says about who signed.
 *
 * A sigstore signature is only interesting if you can see *what identity* made
 * it, and that lives in the certificate: the workflow file, the repository, the
 * ref, the commit, and a link to the run. Everything else in the bundle is
 * machinery for verifying it, which is a job for `cosign`, not for a page.
 *
 * # This is not an X.509 parser
 *
 * It walks DER far enough to reach the extensions and reads the handful this
 * page names. It does not validate anything -- not the chain, not the dates,
 * not the signature. Nothing here decides whether an image is trustworthy; it
 * only says what the certificate claims, and a certificate that lies about that
 * would still have to survive `cosign verify` somewhere that matters.
 *
 * Written by hand because the alternative is a general ASN.1 library for six
 * fields.
 */

type Tlv = { tag: number; start: number; end: number; next: number };
type Span = { start: number; end: number };

/** What a Fulcio certificate says about the run that asked for it. */
export type FulcioIdentity = {
  identity?: string;
  issuer?: string;
  signerUri?: string;
  runnerEnvironment?: string;
  sourceRepository?: string;
  sourceRevision?: string;
  sourceRef?: string;
  buildConfig?: string;
  runUri?: string;
};

/** The extensions Fulcio puts a CI identity in. */
const fulcioExtensions: Record<string, keyof FulcioIdentity> = {
  "1.3.6.1.4.1.57264.1.8": "issuer",
  "1.3.6.1.4.1.57264.1.9": "signerUri",
  "1.3.6.1.4.1.57264.1.11": "runnerEnvironment",
  "1.3.6.1.4.1.57264.1.12": "sourceRepository",
  "1.3.6.1.4.1.57264.1.13": "sourceRevision",
  "1.3.6.1.4.1.57264.1.14": "sourceRef",
  "1.3.6.1.4.1.57264.1.18": "buildConfig",
  "1.3.6.1.4.1.57264.1.21": "runUri",
};

const SUBJECT_ALT_NAME = "2.5.29.17";

/** One DER element: its tag, its contents, and where the next one starts. */
function readTlv(bytes: Uint8Array, at: number): Tlv {
  const tag = bytes[at] ?? 0;
  let length = bytes[at + 1] ?? 0;
  let start = at + 2;

  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) {
      length = length * 256 + (bytes[start + i] ?? 0);
    }

    start += count;
  }

  return { tag, start, end: start + length, next: start + length };
}

function* children(bytes: Uint8Array, from: number, to: number): Generator<Tlv> {
  let at = from;
  while (at < to) {
    const tlv = readTlv(bytes, at);
    yield tlv;
    at = tlv.next;
  }
}

/** An OBJECT IDENTIFIER's contents, in dotted form. */
function readOid(bytes: Uint8Array, from: number, to: number): string {
  const first = bytes[from] ?? 0;
  const parts = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (let i = from + 1; i < to; i++) {
    const byte = bytes[i] ?? 0;
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }

  return parts.join(".");
}

/** DER bytes as the string they encode. */
const decodeString = (bytes: Uint8Array, from: number, to: number) => new TextDecoder().decode(bytes.subarray(from, to));

/**
 * The certificate's extensions, by OID.
 *
 * Certificate ::= SEQUENCE { tbsCertificate, ... }, and the extensions are the
 * `[3]` element of the TBS -- so: into the certificate, into the TBS, find the
 * context tag, and the SEQUENCE inside it is the list.
 */
function extensionsOf(der: Uint8Array): Map<string, Span> {
  const certificate = readTlv(der, 0);
  const tbs = readTlv(der, certificate.start);

  for (const field of children(der, tbs.start, tbs.end)) {
    if (field.tag !== 0xa3) {
      continue;
    }

    const list = readTlv(der, field.start);
    const found = new Map();
    for (const extension of children(der, list.start, list.end)) {
      const parts = [...children(der, extension.start, extension.end)];
      // `critical` is optional, so the value is whichever part is last.
      const id = parts[0];
      const value = parts[parts.length - 1];
      if (id === undefined || value === undefined) {
        continue;
      }

      found.set(readOid(der, id.start, id.end), { start: value.start, end: value.end });
    }

    return found;
  }

  return new Map();
}

/**
 * The identity in the Subject Alternative Name, which for a Fulcio certificate
 * is the URI form: the workflow that asked for it.
 */
function subjectAlternativeName(der: Uint8Array, extension: Span): string | undefined {
  const names = readTlv(der, extension.start);
  for (const name of children(der, names.start, names.end)) {
    // [6] is uniformResourceIdentifier.
    if (name.tag === 0x86) {
      return decodeString(der, name.start, name.end);
    }
  }

  return undefined;
}

/**
 * Reads the fields this page shows out of a DER certificate.
 *
 * Returns an object with whatever was present; a certificate from somewhere
 * other than a CI run simply has fewer of them. Never throws -- a certificate
 * this cannot read must cost the detail view, not the page.
 */
export function readFulcioIdentity(der: Uint8Array): FulcioIdentity {
  try {
    const extensions = extensionsOf(der);
    const identity: FulcioIdentity = {};

    const san = extensions.get(SUBJECT_ALT_NAME);
    if (san !== undefined) {
      identity.identity = subjectAlternativeName(der, san);
    }

    for (const [oid, name] of Object.entries(fulcioExtensions)) {
      const extension = extensions.get(oid);
      if (extension === undefined) {
        continue;
      }

      // The V2 extensions wrap the value in a UTF8String inside the OCTET
      // STRING; reading the inner element when there is one, and the raw bytes
      // when there is not, handles both without knowing which is which.
      const inner = readTlv(der, extension.start);
      const usable = inner.tag === 0x0c && inner.end === extension.end;
      identity[name] = usable
        ? decodeString(der, inner.start, inner.end)
        : decodeString(der, extension.start, extension.end);
    }

    return identity;
  } catch {
    return {};
  }
}

/** Decodes base64 (as the bundle carries the certificate) to bytes. */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}
