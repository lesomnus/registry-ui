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
  key: string;
  label: string;
  current: boolean;
  onSelect: () => void;
};

type Mounted = {
  render: (rows: Row[]) => void;
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
  };
}

function rowElement(row: Row): HTMLElement {
  const button = document.createElement("button");
  button.setAttribute("aria-current", String(row.current));
  button.addEventListener("click", row.onSelect);

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = row.label;
  button.append(name);

  return button;
}
