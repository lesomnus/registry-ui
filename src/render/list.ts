/**
 * A list that only builds the rows you can see.
 *
 * A registry with ten thousand tags is not unusual, and a row per tag is ten
 * thousand elements to build, lay out and keep -- which is slow to open and
 * stays slow, because the cost is paid again on every filter and every
 * selection.
 *
 * So the scroller is sized as though every row were there, and the rows that
 * fall inside the viewport are the only ones that exist. Scrolling replaces
 * them. The scrollbar is the right size, `Home` and `End` land where they
 * should, and nothing above or below has been built.
 */

/**
 * The height of one row, which the stylesheet and this file have to agree on.
 *
 * Measuring it would avoid the agreement, and cost a layout on every render to
 * learn a number that is a constant in the stylesheet.
 */
export const rowHeight = 28;

/** How many rows to build beyond the viewport, so scrolling does not flicker. */
const overscan = 8;

export type Row = {
  /** What identifies this row across a redraw, and across a change of view. */
  key: string;
  label: string;
  current: boolean;
  onSelect: () => void;
  /** How far in to indent it, for a tree. */
  depth?: number;
  expandable?: boolean;
  expanded?: boolean;
  /** What the row is, which decides its icon. */
  kind?: "repository" | "group";
  /** Ranges of `label` that matched what was typed, drawn picked out. */
  matches?: [number, number][];
  /** Said quietly beside the label: where a row came from, mostly. */
  note?: string;
  /**
   * Set when the row is both a group and a thing to select: the caret then
   * toggles and everything else selects. Unset on a plain group, where the
   * whole row toggles because there is nothing else it could do.
   */
  onToggle?: () => void;
};

/**
 * A row, and where its top sits relative to the top of the viewport.
 *
 * Enough to put the same thing back under the same pixel after the rows have
 * been replaced by a different arrangement of the same names.
 *
 * `offset` is measured the way you would point at it -- how far down the
 * viewport the row starts -- so it is slightly negative for a row scrolled
 * halfway off the top, and positive for anything below. Not "how much is cut
 * off above", which only means anything for the topmost row and reads as zero,
 * that is, as "put it at the top", for every other.
 */
export type Anchor = {
  key: string;
  offset: number;
};

type Mounted = {
  render: (rows: Row[]) => void;
  anchor: (key?: string) => Anchor | undefined;
  scrollTo: (anchor: Anchor) => void;
};

const mounted = new WeakMap<HTMLElement, Mounted>();

/**
 * Draws `rows` into `container`, building only what is visible.
 *
 * The scroll listener is attached once per container and kept, so calling this
 * again with a new list is a redraw rather than a rebuild.
 */
export function renderList(container: HTMLElement, rows: Row[], emptyMessage: string): void {
  let state = mounted.get(container);
  if (state === undefined) {
    state = mount(container);
    mounted.set(container, state);
  }

  if (rows.length === 0) {
    container.replaceChildren(paragraph(emptyMessage));
    return;
  }

  state.render(rows);
}

/**
 * Where the list is, or where one particular row is.
 *
 * With no key: the row at the top of the viewport. With one: that row, wherever
 * it happens to be -- which is what holds a row that was clicked in the middle
 * still, rather than lifting it to the top.
 */
export function listAnchor(container: HTMLElement, key?: string): Anchor | undefined {
  return mounted.get(container)?.anchor(key);
}

/** Puts `anchor` back where it was. A row that is no longer there is ignored. */
export function scrollListTo(container: HTMLElement, anchor: Anchor): void {
  mounted.get(container)?.scrollTo(anchor);
}

function paragraph(message: string): HTMLElement {
  const node = document.createElement("p");
  node.className = "empty";
  node.textContent = message;
  return node;
}

function mount(container: HTMLElement): Mounted {
  const sizer = document.createElement("div");
  sizer.className = "list-sizer";

  const window_ = document.createElement("div");
  window_.className = "list-window";
  sizer.append(window_);

  let current: Row[] = [];
  let drawnFrom = -1;
  let drawnTo = -1;

  const draw = (force: boolean) => {
    const height = container.clientHeight || 1;
    const first = Math.max(0, Math.floor(container.scrollTop / rowHeight) - overscan);
    const last = Math.min(current.length, Math.ceil((container.scrollTop + height) / rowHeight) + overscan);

    // Scrolling within what is already built is the common case and is free.
    if (!force && first === drawnFrom && last === drawnTo) {
      return;
    }

    drawnFrom = first;
    drawnTo = last;
    window_.style.transform = `translateY(${first * rowHeight}px)`;
    window_.replaceChildren(...current.slice(first, last).map(rowElement));
  };

  let scheduled = false;
  container.addEventListener("scroll", () => {
    // One draw per frame: a scroll fires far more often than a screen changes.
    if (scheduled) {
      return;
    }

    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      draw(false);
    });
  });

  return {
    render(rows: Row[]) {
      const replaced = container.firstChild !== sizer;
      current = rows;
      sizer.style.height = `${rows.length * rowHeight}px`;
      if (replaced) {
        container.replaceChildren(sizer);
        container.scrollTop = 0;
      }

      draw(true);
    },

    anchor(key?: string) {
      if (current.length === 0) {
        return undefined;
      }

      const index =
        key === undefined
          ? Math.min(current.length - 1, Math.floor(container.scrollTop / rowHeight))
          : current.findIndex((row) => row.key === key);
      const row = current[index];
      return row === undefined ? undefined : { key: row.key, offset: index * rowHeight - container.scrollTop };
    },

    scrollTo(anchor: Anchor) {
      const index = current.findIndex((row) => row.key === anchor.key);
      if (index < 0) {
        return;
      }

      container.scrollTop = index * rowHeight - anchor.offset;
      draw(true);
    },
  };
}

/** How far one level of nesting indents, and where its guide is drawn. */
const indent = 14;

function rowElement(row: Row): HTMLElement {
  const button = document.createElement("button");
  button.setAttribute("aria-current", String(row.current));
  button.addEventListener("click", row.onSelect);

  const depth = row.depth ?? 0;
  if (depth > 0) {
    button.style.paddingLeft = `${8 + depth * indent}px`;

    // One vertical rule per level above this one, so a row shows what it hangs
    // off. Painted rather than added as elements: a row is a fixed height and
    // these have to survive being rebuilt on every scroll.
    button.style.backgroundImage = `repeating-linear-gradient(to right, var(--border-strong) 0 1px, transparent 1px ${indent}px)`;
    button.style.backgroundRepeat = "no-repeat";
    button.style.backgroundPosition = `${8 + Math.floor(indent / 2)}px 0`;
    button.style.backgroundSize = `${depth * indent}px 100%`;
  }

  if (row.expandable) {
    // A caret rather than a disclosure widget: it has to fit in a fixed-height
    // row, and pointing at what it will do is the whole job.
    const caret = element("span", "caret", row.expanded ? "\u25be" : "\u25b8");
    if (row.onToggle !== undefined) {
      // The row is a repository *and* a prefix. Clicking the name opens the
      // image; only the caret opens the group.
      const toggle = row.onToggle;
      caret.addEventListener("click", (event) => {
        event.stopPropagation();
        toggle();
      });
    }

    button.append(caret);
  }

  if (row.kind !== undefined) {
    button.append(icon(row.kind));
  }

  button.append(labelElement(row.label, row.matches));
  if (row.note !== undefined) {
    button.append(element("span", "note", row.note));
  }

  return button;
}

/**
 * The label, with what was searched for picked out of it.
 *
 * Built as spans rather than by setting innerHTML: the text is a repository
 * name from a registry, and the one thing that must not happen is a name being
 * read as markup.
 */
function labelElement(label: string, matches?: [number, number][]): HTMLElement {
  const name = document.createElement("span");
  name.className = "name";

  if (matches === undefined || matches.length === 0) {
    name.textContent = label;
    return name;
  }

  let at = 0;
  for (const [from, to] of matches) {
    if (from > at) {
      name.append(document.createTextNode(label.slice(at, from)));
    }

    name.append(element("mark", "hit", label.slice(from, to)));
    at = to;
  }

  if (at < label.length) {
    name.append(document.createTextNode(label.slice(at)));
  }

  return name;
}

/**
 * A folder or an image.
 *
 * Inline rather than a font or a sprite: two shapes, drawn in `currentColor` so
 * they follow the row, and nothing to load.
 */
function icon(kind: "repository" | "group"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    kind === "group"
      ? // A folder.
        "M1.75 3h3.9a1 1 0 0 1 .7.3L7.6 4.5h6.65a.75.75 0 0 1 .75.75v7A1.75 1.75 0 0 1 13.25 14H2.75A1.75 1.75 0 0 1 1 12.25V3.75A.75.75 0 0 1 1.75 3Z"
      : // A box, seen from above: what an image is drawn as everywhere else.
        "M8 1.2 14.4 4.6v6.8L8 14.8 1.6 11.4V4.6Zm0 1.7L3.6 5.2 8 7.5l4.4-2.3Zm-5 3.6v4.2l4.25 2.25V9.1Zm10 0L8.75 9.1v3.85L13 10.7Z",
  );
  svg.append(path);
  return svg;
}

function element(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}
