// Where the reader left a chat above its end (requested 2026-11-03: "keep the scroll of both the
// chat and artifact saved per session/chat when going to other chats so it doesn't reset to
// bottom/top"), so that the chat shown again opens there instead of at its end. A place is the
// element at the top of the view, found from its message by the path the browser's own scroll
// anchor takes, with how far below the top of the view it and each element on the way began.
// It is kept with the chat's recall in the window's memory (`src/lib/chat-recall.ts`).

/**
 * An element on the way to a place: its kind (its tag and first class) and how many of its
 * siblings before it are of that kind. A step survives siblings of other kinds coming and going,
 * as a reply's Work history does when the Viewer reads a chat it holds light whole again.
 */
export type PlaceStep = { kind: string; nth: number };

/** A reader's place in a conversation's messages. */
export type ChatPlace = {
  message: string;
  /** The elements on the way from the message's down to the element at the top of the view. */
  path: PlaceStep[];
  /** How far below the top of the view the message and each element of `path` began. */
  offsets: number[];
};

/** An element held `offset` pixels below the top of the view. */
export type Anchor = { element: Element; offset: number };

// The top of the conversation's view, which its content scrolls under.
const viewTop = (scroll: HTMLElement) => scroll.getBoundingClientRect().top + scroll.clientTop;

// Content reaching below the top of the view, as the reader sees it there. Content placed out of
// its flow, such as the rail of the button that returns to the end, never marks a place.
function reaches(element: Element, top: number) {
  const box = element.getBoundingClientRect();
  if ((box.width <= 0 && box.height <= 0) || box.bottom <= top) return false;
  const position = getComputedStyle(element).position;
  return position !== 'sticky' && position !== 'fixed' && position !== 'absolute';
}

const kind = (element: Element) =>
  element.classList.length ? `${element.localName}.${element.classList[0]}` : element.localName;

function stepTo(child: Element): PlaceStep {
  const of = kind(child);
  let nth = 0;
  for (
    let sibling = child.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  )
    if (kind(sibling) === of) nth++;
  return { kind: of, nth };
}

function follow(parent: Element, step: PlaceStep): Element | undefined {
  let nth = step.nth;
  for (const child of parent.children) if (kind(child) === step.kind && !nth--) return child;
}

/** The reader's place in `column`, the messages `scroll` scrolls, or none before any message. */
export function readPlace(scroll: HTMLElement, column: HTMLElement): ChatPlace | undefined {
  const top = viewTop(scroll);
  const message = Array.from(column.children).find(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && !!element.dataset.messageId && reaches(element, top),
  );
  if (!message?.dataset.messageId) return;
  const place: ChatPlace = {
    message: message.dataset.messageId,
    path: [],
    offsets: [message.getBoundingClientRect().top - top],
  };
  // The deepest first element reaching below the top of the view.
  for (let element: Element = message; element.getBoundingClientRect().top < top;) {
    const child = Array.from(element.children).find((child) => reaches(child, top));
    if (!child) break;
    place.path.push(stepTo(child));
    place.offsets.push(child.getBoundingClientRect().top - top);
    element = child;
  }
  return place;
}

/**
 * Where `place` is now: the element to hold and its offset, `complete` when its whole path is
 * there, or nothing when its message is gone. When the rest of the path is gone, as when what it
 * was in has not rendered yet, the deepest part still there keeps its own place, though never
 * above the top third of the view.
 */
export function findPlace(scroll: HTMLElement, column: HTMLElement, place: ChatPlace) {
  const message = Array.from(column.children).find(
    (element) => element instanceof HTMLElement && element.dataset.messageId === place.message,
  );
  if (!message) return;
  let element: Element = message;
  let depth = 0;
  for (const step of place.path) {
    const child = follow(element, step);
    if (!child?.getClientRects().length) break;
    element = child;
    depth++;
  }
  const complete = depth === place.path.length;
  let offset = place.offsets[depth] ?? 0;
  if (!complete)
    offset = Math.max(
      offset,
      Math.min(0, scroll.clientHeight / 3 - element.getBoundingClientRect().height),
    );
  return { anchor: { element, offset } as Anchor, complete };
}

/** Scrolls so that the anchor's element begins where it should, reporting whether it moved. */
export function holdAnchor(scroll: HTMLElement, anchor: Anchor) {
  const moved = anchor.element.getBoundingClientRect().top - viewTop(scroll) - anchor.offset;
  if (Math.abs(moved) < 0.5) return false;
  scroll.scrollTop += moved;
  return true;
}
