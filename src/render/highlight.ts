/**
 * Colour for the raw pane, written here rather than pulled in.
 *
 * highlight.js with only JSON and YAML is around 40 KB gzipped; this whole app
 * is 19. Tripling it to colour a pane most sessions never open is the wrong
 * trade, and what a registry holds is not the general case: nearly everything
 * textual in one is JSON, by the `+json` suffix.
 *
 * So JSON gets a real tokenizer and YAML a line-based one, and anything else is
 * shown as it came. Colour that is wrong is worse than none, so the YAML pass
 * only marks what it can be sure of.
 *
 * Nodes are built rather than markup assembled: a blob is bytes somebody else
 * pushed, and it is never going anywhere near `innerHTML`.
 */

/**
 * Above this, the text is shown plain.
 *
 * Highlighting means one element per token, and a megabyte of JSON is a few
 * hundred thousand of them -- long enough to hang the tab, for colour.
 */
const highlightableBytes = 256 * 1024;

type Kind = "key" | "string" | "number" | "literal" | "punct" | "comment";

const span = (kind: Kind, text: string): HTMLSpanElement => {
  const node = document.createElement("span");
  node.className = `tok-${kind}`;
  node.textContent = text;
  return node;
};

/**
 * Strings, numbers and the three literals, with a string that is followed by a
 * colon marked as a key instead.
 *
 * Everything the pattern does not claim -- whitespace, braces, commas -- falls
 * through as plain text, which is why this cannot mangle a document it does not
 * understand: the worst it does is fail to colour something.
 */
const jsonPattern = /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function highlightJson(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let at = 0;

  for (const match of text.matchAll(jsonPattern)) {
    const index = match.index;
    if (index > at) {
      fragment.append(text.slice(at, index));
    }

    const [whole, string, colon] = match;
    if (string !== undefined) {
      fragment.append(span(colon === undefined ? "string" : "key", string));
      if (colon !== undefined) {
        fragment.append(colon);
      }
    } else if (whole === "true" || whole === "false" || whole === "null") {
      fragment.append(span("literal", whole));
    } else {
      fragment.append(span("number", whole));
    }

    at = index + whole.length;
  }

  fragment.append(text.slice(at));
  return fragment;
}

/**
 * A key at the start of a line, a comment, and quoted scalars.
 *
 * Line-based on purpose. YAML is not a language a regex can read -- block
 * scalars alone see to that -- so this claims only the two shapes that are
 * unambiguous at the start of a line and leaves the rest alone.
 */
const yamlKey = /^(\s*(?:-\s+)?)([A-Za-z_][\w.-]*)(\s*:)(?=\s|$)/;
const yamlScalar = /("(?:\\.|[^"\\])*"|'(?:''|[^'])*')|\b(?:true|false|null|~)\b|(?<![\w.-])-?\d+(?:\.\d+)?(?![\w.-])/g;

function highlightYaml(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();

  for (const [index, line] of text.split("\n").entries()) {
    if (index > 0) {
      fragment.append("\n");
    }

    const comment = line.indexOf("#");
    // Only a comment when nothing quoted opened before it; anything subtler
    // than that is not worth being wrong about.
    const isComment = comment >= 0 && !line.slice(0, comment).includes('"') && !line.slice(0, comment).includes("'");
    const body = isComment ? line.slice(0, comment) : line;

    let rest = body;
    const key = yamlKey.exec(body);
    if (key !== null) {
      fragment.append(key[1] ?? "", span("key", key[2] ?? ""), key[3] ?? "");
      rest = body.slice(key[0].length);
    }

    let at = 0;
    for (const match of rest.matchAll(yamlScalar)) {
      const start = match.index;
      if (start > at) {
        fragment.append(rest.slice(at, start));
      }

      const [whole, quoted] = match;
      fragment.append(span(quoted !== undefined ? "string" : /^-?\d/.test(whole) ? "number" : "literal", whole));
      at = start + whole.length;
    }

    fragment.append(rest.slice(at));
    if (isComment) {
      fragment.append(span("comment", line.slice(comment)));
    }
  }

  return fragment;
}

/**
 * The text, coloured if this knows how and plain if it does not.
 *
 * Answers whether it coloured, so the pane can say "too large to highlight"
 * rather than leaving somebody to wonder why this one is grey.
 */
export function highlight(
  text: string,
  mediaType: string | undefined,
): { nodes: Node; language?: string; tooLarge: boolean } {
  const type = (mediaType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const language =
    type === "application/json" || type.endsWith("+json")
      ? "json"
      : type === "application/yaml" || type === "application/x-yaml" || type.endsWith("+yaml")
        ? "yaml"
        : undefined;

  if (language === undefined) {
    return { nodes: document.createTextNode(text), tooLarge: false };
  }

  if (text.length > highlightableBytes) {
    return { nodes: document.createTextNode(text), language, tooLarge: true };
  }

  return { nodes: language === "json" ? highlightJson(text) : highlightYaml(text), language, tooLarge: false };
}
