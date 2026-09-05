import { readBlobBytes, readBlobText, viewableBytes } from "../manifest";
import { extensionFor, isJson, isTextual } from "../media-types";
import type { RegistryClient } from "../registry";
import type { Cell } from "./dom";
import { element, formatSize, shortDigest, table } from "./dom";
import { highlight } from "./highlight";

/** A layer, as every manifest shape here describes one. */
export type Layer = {
  digest: string;
  size?: number;
  mediaType?: string;
  annotations?: Record<string, string>;
};

/** What `oras push` calls the file it pushed. */
const titleAnnotation = "org.opencontainers.image.title";

const titleOf = (layer: Layer): string | undefined => layer.annotations?.[titleAnnotation];

/**
 * What to call this layer on screen and on disk.
 *
 * `oras push ref file.txt` records the name in an annotation, and for an
 * artifact that name is the whole point -- it is the file somebody pushed, and
 * a digest is not what they will look for. Without one there is nothing but the
 * digest, and a guessed extension so that opening it does something sensible.
 */
export function fileNameOf(layer: Layer): string {
  const title = titleOf(layer);
  if (title !== undefined && title !== "") {
    // A title is written by whoever pushed. It is used as a download name and
    // nowhere else, and a path in it would aim that download somewhere.
    return title.replace(/[/\\]/g, "_").replace(/^\.+/, "");
  }

  return `${shortDigest(layer.digest)}${extensionFor(layer.mediaType)}`;
}

/** JSON as something to read; anything else as it arrived. */
function pretty(text: string, mediaType: string | undefined): string {
  if (!isJson(mediaType)) {
    return text;
  }

  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    // JSON that will not parse is worth seeing exactly as it is; that it does
    // not parse is the interesting part.
    return text;
  }
}

const message = (error: unknown): string => String((error as Error).message ?? error);

/** A pane of text, sized to the panel and scrolling rather than growing it. */
export function rawPane(text: string, mediaType: string | undefined, note?: string): Node {
  const fragment = document.createDocumentFragment();
  const body = pretty(text, mediaType);
  const { nodes, language, tooLarge } = highlight(body, mediaType);

  const notes = [
    note,
    tooLarge ? `Too large to highlight, so this is ${language ?? "plain"} without colour.` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join(" ");
  if (notes !== "") {
    fragment.append(element("p", "empty", notes));
  }

  const pre = element("pre", "raw");
  pre.append(nodes);
  fragment.append(pre);
  return fragment;
}

async function save(
  client: RegistryClient,
  repository: string,
  layer: Layer,
  button: HTMLButtonElement,
): Promise<void> {
  // The label is the size, so it is restored rather than remembered: whatever
  // this says while it is working, it goes back to saying how big the layer is.
  button.disabled = true;
  button.textContent = "saving...";

  try {
    const blob = await readBlobBytes(client, repository, layer.digest);

    // In the document before it is clicked: a detached anchor works in some
    // browsers and is ignored in others, and this is not worth finding out
    // about from a bug report.
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download = fileNameOf(layer);
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();

    // Revoked later rather than now: taking the URL away before the browser
    // has followed it cancels the download it was for.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    button.textContent = formatSize(layer.size);
  } catch (error) {
    // The forwarder refuses a body over its limit, and a registry can refuse
    // for its own reasons. Either way the button is where the person is
    // looking, so that is where it is said.
    button.textContent = "failed";
    button.title = message(error);
    console.warn("blob download failed", error);
    setTimeout(() => (button.textContent = formatSize(layer.size)), 4000);
  } finally {
    button.disabled = false;
  }
}

/**
 * The layers of a manifest, as things you can look at rather than as digests.
 *
 * Every manifest here has layers and none of them showed what was in one, which
 * for an artifact means the page showed everything except the artifact. Two
 * ways in, and which are offered depends on what the layer says it is:
 *
 * - **view**, for a media type that is text. The name is the handle, the way a
 *   platform and an artifact type are elsewhere. JSON is indented on the way
 *   out; anything else is shown as it arrived.
 * - **save**, on the size. What a layer costs to download is what its size
 *   says, so that is the thing to hang the download on rather than a word in a
 *   column of its own -- and the file is named by the
 *   `org.opencontainers.image.title` annotation when the pusher left one.
 *
 * Nothing is fetched until something is clicked: a manifest names its layers
 * and their sizes, so the table is drawn from the manifest alone.
 */
export function layersSection(client: RegistryClient, repository: string, layers: Layer[], heading = "Layers"): Node {
  const fragment = document.createDocumentFragment();
  fragment.append(element("h3", undefined, heading));

  if (layers.length === 0) {
    fragment.append(element("p", "empty", "No layers."));
    return fragment;
  }

  const detail = element("div", "artifact-detail");

  const rows: Cell[][] = layers.map((layer) => {
    const name = fileNameOf(layer);
    const readable = isTextual(layer.mediaType);
    const tooBig = (layer.size ?? 0) > viewableBytes;

    let first: Cell;
    if (readable && !tooBig) {
      const open = element("button", "linklike", name);
      open.title = `Show ${name}`;
      open.addEventListener("click", () => void view(client, repository, layer, detail));
      first = { text: name, node: open };
    } else {
      const label = element("span", undefined, name);
      label.title = readable
        ? `${formatSize(layer.size)} is more than this page will read to show it — save it instead`
        : `${layer.mediaType ?? "this type"} is not text`;
      first = { text: name, node: label };
    }

    const download = element("button", "linklike", formatSize(layer.size));
    download.title = `Download ${name}`;
    download.addEventListener("click", () => void save(client, repository, layer, download));

    return [
      first,
      { text: layer.mediaType ?? "-" },
      { text: shortDigest(layer.digest) },
      { text: formatSize(layer.size), node: download, numeric: true },
    ];
  });

  fragment.append(
    table([{ text: "Layer" }, { text: "Media type" }, { text: "Digest" }, { text: "Size", numeric: true }], rows),
    detail,
  );

  return fragment;
}

async function view(client: RegistryClient, repository: string, layer: Layer, into: HTMLElement): Promise<void> {
  into.replaceChildren(element("p", "loading", "Reading..."));

  try {
    const { text, truncated } = await readBlobText(client, repository, layer.digest);
    const panel = element("div", "panel");
    panel.append(
      element("h3", undefined, fileNameOf(layer)),
      rawPane(text, layer.mediaType, truncated ? `Showing the first ${formatSize(viewableBytes)}.` : undefined),
    );
    into.replaceChildren(panel);
  } catch (error) {
    into.replaceChildren(element("p", "error", message(error)));
  }
}
