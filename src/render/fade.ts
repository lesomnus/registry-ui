/**
 * The edge a scroll is hiding, faded into the pane behind it.
 *
 * A pane that is scrolled has content above the top of it, and nothing on
 * screen says so: the first visible row looks exactly like the first row. So
 * the content fades out towards the edge it continues past, in the pane's own
 * colour, which reads as "there is more this way" without anything being drawn
 * that is not already there.
 *
 * **It follows the scroll rather than switching on.** At one pixel of scroll
 * the fade is one pixel deep, and it reaches full depth over `ramp`. A fade
 * that appears whole the instant you touch the wheel is a flicker; one that
 * grows is the same information without the flinch.
 *
 * **It never reaches nothing.** `--fade-min` in the stylesheet is what is left
 * of the content at the very edge, and it is deliberately not zero: the ramp is
 * about a row tall, so a fade that went all the way took the whole row you were
 * scrolling past. A row that is gone says the list starts there, which is the
 * opposite of the point. Something has to survive it to be the thing you are
 * being told about.
 *
 * # Why a mask
 *
 * The fade has to be *over* the content -- the point is that the content
 * disappears into the background -- so a background gradient is the wrong tool,
 * being behind everything. An overlay element would need somewhere to live in
 * every pane, and the panes do not have the same shape.
 *
 * A mask is neither: the element fades itself out at its own edges, whatever is
 * behind it shows through, and it costs two custom properties and no markup.
 */

/**
 * How far you scroll before the fade is as deep as it gets.
 *
 * A row is 28px, so in the lists this is the row being scrolled past and no
 * more: exactly the one that is half gone is the one half faded. The panes that
 * are not lists have no rows and the same distance reads the same.
 */
const ramp = 28;

const clamp = (value: number): number => Math.max(0, Math.min(ramp, value));

/**
 * Fades `container` at whichever edge it is scrolled past.
 *
 * Safe to call twice on the same element; the second call does nothing.
 */
export function fadeEdges(container: HTMLElement): void {
  if (container.dataset["faded"] === "yes") {
    return;
  }

  container.dataset["faded"] = "yes";
  container.classList.add("faded");

  let scheduled = false;

  const update = (): void => {
    const above = clamp(container.scrollTop);
    const below = clamp(container.scrollHeight - container.scrollTop - container.clientHeight);
    container.style.setProperty("--fade-top", `${above}px`);
    container.style.setProperty("--fade-bottom", `${below}px`);
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
