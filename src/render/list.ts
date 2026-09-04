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
};

/**
 * Where the list is: the row at the top of the viewport, and how much of it is
 * cut off above.
 *
 * Enough to put the same thing back under the same pixel after the rows have
 * been replaced by a different arrangement of the same names.
 */
export type Anchor = {
  key: string;
  offset: number;
};

type Mounted = {
  render: (rows: Row[]) => void;
  anchor: () => Anchor | undefined;
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

/** Where the list is, or nothing if it has never been drawn. */
export function listAnchor(container: HTMLElement): Anchor | undefined {
  return mounted.get(container)?.anchor();
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

    anchor() {
      if (current.length === 0) {
        return undefined;
      }

      const index = Math.min(current.length - 1, Math.floor(container.scrollTop / rowHeight));
      const row = current[index];
      return row === undefined ? undefined : { key: row.key, offset: container.scrollTop - index * rowHeight };
    },

    scrollTo(anchor: Anchor) {
      const index = current.findIndex((row) => row.key === anchor.key);
      if (index < 0) {
        return;
      }

      container.scrollTop = index * rowHeight + anchor.offset;
      draw(true);
    },
  };
}

function rowElement(row: Row): HTMLElement {
  const button = document.createElement("button");
  button.setAttribute("aria-current", String(row.current));
  button.addEventListener("click", row.onSelect);
  if (row.depth) {
    button.style.paddingLeft = `${8 + row.depth * 14}px`;
  }

  if (row.expandable) {
    // A caret rather than a disclosure widget: it has to fit in a row that is a
    // fixed height, and pointing at what it will do is the whole job.
    button.append(element("span", "caret", row.expanded ? "\u25be" : "\u25b8"));
  }

  button.append(element("span", "name", row.label));
  return button;
}

function element(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}
