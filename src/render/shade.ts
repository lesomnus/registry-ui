/**
 * A shadow cast over the edge a scroll is hiding.
 *
 * A pane that is scrolled has content above the top of it, and nothing on
 * screen said so: the first visible row looked exactly like the first row.
 *
 * It took three goes to get right, and the two failures are worth keeping.
 *
 * It was a mask first: the element faded out its own pixels. A mask *removes*
 * content, so what it drew was the list being cut off by something rather than
 * something lying over it, and there was no depth that fixed that -- shallow
 * enough not to eat a row it read as an accident, deep enough to read as
 * deliberate it ate the row it was meant to be telling you about.
 *
 * Then it was a dark gradient, which is what "shadow" usually means, and that
 * was worse in a different way: a colour the pane does not have anywhere else
 * reads as a band laid across it. A strip, not a shadow.
 *
 * What it is now is the pane's own surface, opaque where it begins and thinning
 * with distance -- so there is no edge to notice, only content going under
 * something. A shadow needs a thing to fall from, and at the top that is
 * whatever sits above the scroller: the filter box, the pane heading. Which is
 * why the gap under the filter box is gone -- the surface has to start at its
 * edge or there is a strip of pane between the two that nothing crosses. At the
 * bottom it is the pane's own end.
 *
 * # How it is placed without measuring anything
 *
 * Two elements of zero height, one before the scroller and one after, in the
 * pane's flex column. Being in the flow, they are already exactly where the
 * scroller begins and ends, whatever is above it in that particular pane, and
 * they span its full width. Each paints its shadow out of that line with an
 * absolutely positioned `::after` that takes up no room.
 *
 * **It follows the scroll rather than switching on.** What ramps is the whole
 * thing's opacity, not its size: an edge covering more of what is under it
 * rather than reaching further. A shadow that arrives whole the instant you
 * touch the wheel is a flicker.
 */

/** How far you scroll before the shadow is at full strength. */
const ramp = 32;

const strength = (distance: number): number => Math.max(0, Math.min(1, distance / ramp));

/**
 * Shadows `container` at whichever edge it is scrolled past.
 *
 * The container has to be a child of a column, which every pane here is, since
 * that is what puts the two shadows where the scroller starts and stops.
 *
 * Safe to call twice on the same element; the second call does nothing.
 */
export function shadeEdges(container: HTMLElement): void {
  if (container.dataset["shaded"] === "yes") {
    return;
  }

  container.dataset["shaded"] = "yes";

  const above = document.createElement("div");
  above.className = "shade shade-top";
  above.setAttribute("aria-hidden", "true");

  const below = document.createElement("div");
  below.className = "shade shade-bottom";
  below.setAttribute("aria-hidden", "true");

  container.before(above);
  container.after(below);

  let scheduled = false;

  const update = (): void => {
    above.style.setProperty("--shade", `${strength(container.scrollTop)}`);
    below.style.setProperty(
      "--shade",
      `${strength(container.scrollHeight - container.scrollTop - container.clientHeight)}`,
    );
  };

  // Coalesced to one a frame. Every source below can fire in bursts -- a scroll
  // does, and so does a virtualised list rewriting its window -- and the work
  // is a layout read, which is the thing not to do in a burst.
  const schedule = (): void => {
    if (scheduled) {
      return;
    }

    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      update();
    });
  };

  container.addEventListener("scroll", schedule, { passive: true });

  // The pane resizing changes what is below; so does the list growing a page,
  // which is a height on a child rather than anything this element would hear
  // about. Both are watched rather than reported, so nothing has to remember to
  // call this after a render.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(schedule).observe(container);
  }

  if (typeof MutationObserver === "function") {
    new MutationObserver(schedule).observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
  }

  update();
}
