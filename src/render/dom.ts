/** The handful of shapes every view here is built out of. */

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  content?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (content !== undefined) {
    node.textContent = content;
  }

  return node;
}

export type Cell = { text: string; numeric?: boolean; node?: Node };

/** A table, where a cell is either a string or something already built. */
export function table(headers: Cell[], rows: Cell[][]): HTMLTableElement {
  const element_ = document.createElement("table");
  const head = document.createElement("tr");
  for (const header of headers) {
    head.append(element("th", header.numeric ? "numeric" : undefined, header.text));
  }

  element_.append(head);
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = element("td", cell.numeric ? "numeric" : undefined, cell.node ? undefined : cell.text);
      if (cell.node) {
        td.append(cell.node);
      }

      tr.append(td);
    }

    element_.append(tr);
  }

  return element_;
}

/** A term list, skipping anything there is no value for. */
export function definitions(rows: [string, string | number | undefined][]): HTMLDListElement {
  const list = document.createElement("dl");
  for (const [term, value] of rows) {
    if (value === undefined || value === "") {
      continue;
    }

    list.append(element("dt", undefined, term), element("dd", undefined, String(value)));
  }

  return list;
}

export function externalLink(label: string, href: string): HTMLAnchorElement {
  const link = element("a", "external", label);
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  return link;
}

export function formatSize(bytes: number | undefined): string {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) {
    return "-";
  }

  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function shortDigest(digest: string | undefined): string {
  const hex = String(digest ?? "").replace(/^sha256:/, "");
  return hex.length > 12 ? hex.slice(0, 12) : hex;
}

/**
 * Publishes the width of a scrollbar as `--sb`, once.
 *
 * The lists reserve a scrollbar's width on both edges so their rows stay
 * centred, and the filter box above them has to end up a little wider than
 * those rows -- on a platform whose scrollbars are 15px wide and on one whose
 * scrollbars are overlaid and take no room at all. Those two cannot both be
 * satisfied by a number written in the stylesheet, so the stylesheet subtracts
 * this one and the sum comes out the same either way.
 *
 * Measured off a probe with a scrollbar rather than off a list: with
 * `scrollbar-gutter` a list's own missing width is two gutters, and halving it
 * is a worse way to learn the same number.
 */
export function publishScrollbarWidth(): void {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;top:-9999px;width:100px;height:100px;overflow-y:scroll";
  document.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();

  document.documentElement.style.setProperty("--sb", `${width}px`);
}
