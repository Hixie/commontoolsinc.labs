/**
 * Brings the tiles on the page up to date with a fresh rendering. This runs in
 * the browser, on every update the server sends. A tile is matched with its
 * earlier rendering by its label, which the renderer writes into its
 * `data-tile-label` attribute and which is unique among the dashboard's tiles.
 * A tile whose markup has not changed is left in place, and a changed tile is
 * replaced, keeping the scroll position of its list and the keyboard focus
 * inside it. Tiles are then put in the rendering's order, and a tile the
 * rendering no longer has is removed.
 */

/** Makes the tiles in `container` match `rendered`, tile by tile. */
export function reconcileTiles(
  container: Element,
  rendered: readonly HTMLElement[],
): void {
  const onPage = new Map(
    [...container.children].map((tile) => [
      tile.getAttribute("data-tile-label"),
      tile,
    ]),
  );
  const tiles = rendered.map((next) => {
    const label = next.getAttribute("data-tile-label");
    const current = onPage.get(label);
    if (!current) return next;
    onPage.delete(label);
    if (current.outerHTML === next.outerHTML) return current;

    const scrollTop = current.querySelector(".evscroll")?.scrollTop;
    const active = document.activeElement;
    const rootFocused = active === current;
    const focusedLink = active instanceof HTMLAnchorElement &&
        current.contains(active)
      ? active
      : null;
    current.replaceWith(next);
    const nextScroller = next.querySelector(".evscroll");
    if (scrollTop !== undefined && nextScroller) {
      nextScroller.scrollTop = scrollTop;
    }
    if (rootFocused) next.focus({ preventScroll: true });
    else if (focusedLink) {
      const links = [...next.querySelectorAll("a")];
      const focusKey = focusedLink.dataset.focusKey;
      const replacement = focusKey
        ? links.find((link) => link.dataset.focusKey === focusKey)
        : undefined;
      (replacement ?? links.find((link) => link.href === focusedLink.href))
        ?.focus({ preventScroll: true });
    }
    return next;
  });
  for (const removed of onPage.values()) removed.remove();
  tiles.forEach((tile, index) => {
    const atIndex = container.children.item(index);
    if (atIndex !== tile) container.insertBefore(tile, atIndex);
  });
}
