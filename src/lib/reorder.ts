import { orderSpaces, type OrderSpace } from './sidebar-order';

// Moving the sidebar's chats, folders and computers by hand. A list is an element marked with
// `data-order-space`, the list it is (src/lib/sidebar-order.ts), whose children marked
// `data-order` are its items in the order shown, each naming its id; the element an item is moved
// by carries `data-order-handle`. A press with the mouse or a pen that moves a few pixels along the
// list lifts the item: it follows the pointer, the rest of the list makes room where it would land,
// and it lands there once released. Alt with the up or down arrow moves the focused item one place.
// Nothing here knows the page: the page is told which list moved and where.

/** A list as the page shows it, and the item a press or a key moves in it. */
export type OrderList = {
  space: OrderSpace;
  /** Its items' ids, in the order shown. */
  ids: string[];
  /** The moving item's position. */
  index: number;
  container: HTMLElement;
};
/**
 * How a move came about. `focus`: the moved item had keyboard focus, which follows it to its new
 * place; `keyboard`: a key moved it, so the item is also scrolled into view.
 */
export type MoveOptions = { focus: boolean; keyboard: boolean };
export type Move = (list: OrderList, to: number, options: MoveOptions) => void;

const itemsOf = (container: Element) =>
  [...container.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement && 'order' in child.dataset,
  );
/** The list of the item `element` belongs to, read from the page as shown. */
export function orderList(element: Element): OrderList | undefined {
  const item = element.closest<HTMLElement>('[data-order]');
  const container = item?.parentElement;
  const space = container?.dataset.orderSpace as OrderSpace | undefined;
  if (!item || !container || !space || !orderSpaces.includes(space)) return;
  const items = itemsOf(container);
  return {
    space,
    ids: items.map((element) => element.dataset.order!),
    index: items.indexOf(item),
    container,
  };
}
/** Gives focus to the handle of the item `id` of a list, as it shows after a move. */
export function focusItem(container: HTMLElement, id: string, preventScroll = false) {
  itemsOf(container)
    .find((item) => item.dataset.order === id)
    ?.querySelector<HTMLElement>('[data-order-handle]')
    ?.focus({ preventScroll });
}

/** Alt with the up or down arrow moves the focused item one place within its list. */
export function keyToReorder(event: KeyboardEvent, move: Move) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  const list = event.currentTarget instanceof Element ? orderList(event.currentTarget) : undefined;
  if (!list) return;
  event.preventDefault();
  const to = list.index + (event.key === 'ArrowUp' ? -1 : 1);
  if (to < 0 || to >= list.ids.length) return;
  move(list, to, { focus: true, keyboard: true });
}

// How far the pointer moves along the list before a press becomes a drag, the band at each end of
// the scrolling list that scrolls it while an item is dragged there, and the fastest it scrolls, in
// pixels a second, so every display scrolls as fast however often it draws.
const THRESHOLD = 5;
const EDGE = 40;
const SPEED = 900;
// No press while a dropped item settles into its place, whose transforms a new press would
// measure; and a press whose release never arrived gives way to the next.
let settling = false;
let stale: (() => void) | undefined;

/**
 * Follows a press on an item's handle. Once the pointer moves a few pixels along the list, the
 * item is dragged; releasing it lands it where the list made room and tells `move`, while Escape
 * or a lost pointer puts it back, and the click that ends a drag does nothing. Touches are left to
 * scroll the list and to open menus.
 */
export function pressToReorder(event: PointerEvent, move: Move) {
  if (settling || event.button !== 0 || !event.isPrimary || event.pointerType === 'touch') return;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const handle = event.currentTarget;
  if (!(handle instanceof HTMLElement)) return;
  stale?.();
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const startY = event.clientY;
  let pointerY = startY;
  let drag: Drag | undefined;
  // Whether the press became a drag, even one put back with Escape.
  let dragged = false;
  let frame = 0;
  let drawn: number | undefined;

  const scrollFrame = (now: number) => {
    const elapsed = Math.min(50, now - (drawn ?? now));
    drawn = now;
    if (drag?.scroll(pointerY, elapsed)) drag.follow(pointerY);
    frame = requestAnimationFrame(scrollFrame);
  };
  const pointermove = (moved: PointerEvent) => {
    if (moved.pointerId !== pointerId) return;
    pointerY = moved.clientY;
    if (!drag) {
      if (dragged) return;
      const dy = Math.abs(moved.clientY - startY);
      // A press that wanders sideways stays a press.
      if (dy < THRESHOLD || dy < Math.abs(moved.clientX - startX)) return;
      const list = orderList(handle);
      drag = list && list.ids.length > 1 ? lift(handle, list, startY) : undefined;
      if (!drag) return finish();
      dragged = true;
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        // The window's events follow the drag either way.
      }
      frame = requestAnimationFrame(scrollFrame);
    }
    moved.preventDefault();
    drag.follow(pointerY);
  };
  const pointerup = (released: PointerEvent) => {
    if (released.pointerId === pointerId) finish('drop');
  };
  const pointercancel = (cancelled: PointerEvent) => {
    if (cancelled.pointerId === pointerId) finish('cancel');
  };
  const keydown = (key: KeyboardEvent) => {
    if (key.key !== 'Escape' || !drag) return;
    key.preventDefault();
    key.stopPropagation();
    cancelAnimationFrame(frame);
    const lifted = drag;
    drag = undefined;
    settling = true;
    lifted.cancel(() => (settling = false));
  };
  const blur = () => finish('cancel');
  // The click that ends a drag opens nothing and toggles nothing.
  const click = (clicked: MouseEvent) => {
    clicked.preventDefault();
    clicked.stopPropagation();
    window.removeEventListener('click', click, true);
  };
  function finish(how?: 'drop' | 'cancel') {
    stale = undefined;
    window.removeEventListener('pointermove', pointermove, true);
    window.removeEventListener('pointerup', pointerup, true);
    window.removeEventListener('pointercancel', pointercancel, true);
    window.removeEventListener('keydown', keydown, true);
    window.removeEventListener('blur', blur);
    cancelAnimationFrame(frame);
    if (dragged) {
      window.addEventListener('click', click, true);
      setTimeout(() => window.removeEventListener('click', click, true));
    }
    const lifted = drag;
    drag = undefined;
    if (!lifted) return;
    settling = true;
    const settled = () => (settling = false);
    if (how === 'drop') lifted.drop(move, settled);
    else lifted.cancel(settled);
  }
  stale = () => finish('cancel');
  window.addEventListener('pointermove', pointermove, true);
  window.addEventListener('pointerup', pointerup, true);
  window.addEventListener('pointercancel', pointercancel, true);
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('blur', blur);
}

type Drag = {
  follow(pointerY: number): void;
  /**
   * Scrolls the list for `elapsed` milliseconds while the pointer is near one of its ends,
   * faster the nearer; reports whether it scrolled.
   */
  scroll(pointerY: number, elapsed: number): boolean;
  drop(move: Move, settled: () => void): void;
  cancel(settled?: () => void): void;
};

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// The nearest ancestor that scrolls the list.
function scrollerOf(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : undefined;
}

// Lifts the item of `list` pressed at `startY`. Positions are measured once, in the scrolling
// list's own coordinates, so they hold while it scrolls; the page's layout never changes during a
// drag, only transforms do, and the list takes the new order at once when the item lands.
function lift(handle: HTMLElement, list: OrderList, startY: number): Drag | undefined {
  const scroller = scrollerOf(list.container);
  const elements = itemsOf(list.container);
  const index = list.index;
  const item = elements[index];
  if (!scroller || !item || !item.contains(handle)) return;
  const count = elements.length;
  const frameTop = () => scroller.getBoundingClientRect().top;
  const contentY = (clientY: number) => clientY - frameTop() + scroller.scrollTop;
  const origin = scroller.scrollTop - frameTop();
  const rects = elements.map((element) => element.getBoundingClientRect());
  const tops = rects.map((rect) => rect.top + origin);
  const heights = rects.map((rect) => rect.height);
  const height = heights[index];
  // The room the item takes in its list, the space to its neighbour included.
  const gap =
    index + 1 < count
      ? tops[index + 1] - tops[index] - height
      : tops[index] - tops[index - 1] - heights[index - 1];
  const step = height + Math.max(0, gap);
  const start = contentY(startY);
  const lowest = tops[0] - tops[index];
  const highest = tops[count - 1] + heights[count - 1] - height - tops[index];
  let target = index;
  let offset = 0;

  getSelection()?.removeAllRanges();
  document.documentElement.classList.add('sidebar-reordering');
  list.container.classList.add('order-moving');
  item.classList.add('order-lifted');

  const shift = (k: number) =>
    target > index && k > index && k <= target
      ? -step
      : target < index && k >= target && k < index
        ? step
        : 0;
  const place = () => {
    item.style.transform = `translateY(${offset}px)`;
    elements.forEach((element, k) => {
      if (k === index) return;
      const by = shift(k);
      element.style.transform = by ? `translateY(${by}px)` : '';
    });
  };
  // Where the item shows once it lands at `to`, as an offset from where it was.
  const slot = (to: number) =>
    to > index
      ? tops[to] + heights[to] - height - tops[index]
      : to < index
        ? tops[to] - tops[index]
        : 0;
  const clear = () => {
    for (const element of elements) element.style.transform = '';
    item.classList.remove('order-lifted', 'order-landing');
    list.container.classList.remove('order-moving');
    document.documentElement.classList.remove('sidebar-reordering');
  };
  // Glides the item into the place it lands in, then runs `then`.
  const settle = (to: number, then: () => void) => {
    const end = slot(to);
    if (reducedMotion() || Math.abs(end - offset) < 1 || !item.isConnected) return then();
    item.classList.add('order-landing');
    offset = end;
    item.style.transform = `translateY(${end}px)`;
    let done = false;
    const complete = (event?: TransitionEvent) => {
      if (done || (event && (event.target !== item || event.propertyName !== 'transform'))) return;
      done = true;
      item.removeEventListener('transitionend', complete);
      then();
    };
    item.addEventListener('transitionend', complete);
    setTimeout(complete, 250);
  };
  return {
    follow(pointerY) {
      offset = Math.max(lowest, Math.min(highest, contentY(pointerY) - start));
      const top = tops[index] + offset;
      const bottom = top + height;
      // It takes the place of each item whose middle it passes.
      target = index;
      if (offset > 0)
        while (target + 1 < count && bottom > tops[target + 1] + heights[target + 1] / 2) target++;
      else if (offset < 0)
        while (target > 0 && top < tops[target - 1] + heights[target - 1] / 2) target--;
      place();
    },
    scroll(pointerY, elapsed) {
      const bounds = scroller.getBoundingClientRect();
      const above = pointerY - bounds.top;
      const below = bounds.bottom - pointerY;
      const speed = (distance: number) =>
        (((EDGE - Math.max(0, distance)) / EDGE) * SPEED * elapsed) / 1000;
      const by = above < EDGE ? -speed(above) : below < EDGE ? speed(below) : 0;
      if (!by) return false;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + by;
      return scroller.scrollTop !== before;
    },
    drop(move, settled) {
      const to = target;
      const focus = document.activeElement === handle;
      settle(to, () => {
        clear();
        settled();
        if (to !== index && item.isConnected) move(list, to, { focus, keyboard: false });
      });
    },
    cancel(settled) {
      target = index;
      place();
      settle(index, () => {
        clear();
        settled?.();
      });
    },
  };
}
