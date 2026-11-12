// Height a node's content needs on its own, ignoring the min-height set by resizing
export function contentHeight(nodeEl: HTMLElement): number {
  const card = nodeEl.querySelector('.study-node') as HTMLElement | null;
  if (!card) return 0;
  let height = card.offsetHeight - card.clientHeight; // borders
  for (const child of Array.from(card.children) as HTMLElement[]) {
    const position = getComputedStyle(child).position;
    if (position !== 'absolute' && position !== 'fixed') height += child.offsetHeight;
  }
  return height;
}

// Node data after a resize. A height at or below what the content needs is dropped,
// so shrinking a node snaps it to its content instead of leaving blank space
export function resizedData(data: Record<string, unknown>, width: number, height: number, nodeEl: HTMLElement | null) {
  const next: Record<string, unknown> = { ...data, width, height };
  if (nodeEl && height <= contentHeight(nodeEl) + 1) delete next.height;
  return next;
}

export function nodeElement(id: string) {
  return document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`) as HTMLElement | null;
}

// Height of everything in the node except its images, which only scale with the width
function textHeight(nodeEl: HTMLElement): number {
  let height = contentHeight(nodeEl);
  for (const img of Array.from(nodeEl.querySelectorAll('.study-node img')) as HTMLElement[]) height -= img.offsetHeight;
  return height;
}

// True if something in the node is cut off sideways (a long word, a formula, the header's buttons).
// Only boxes that clip or scroll count: KaTeX's inner boxes always stick out a little by design,
// and its MathML copy is for screen readers and always squeezed into 1px
function overflows(card: HTMLElement): boolean {
  if (card.scrollWidth > card.clientWidth + 1) return true;
  for (const el of Array.from(card.querySelectorAll('*')) as HTMLElement[]) {
    if (el.closest('.katex-mathml') || getComputedStyle(el).overflowX === 'visible') continue;
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) return true;
  }
  // Right-to-left text spills out on the left, which scrollWidth doesn't count
  const { left, right } = card.getBoundingClientRect();
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text.parentElement?.closest('.katex-mathml')) continue;
    range.selectNodeContents(text);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width > 0 && (rect.left < left - 1 || rect.right > right + 1)) return true;
    }
  }
  return false;
}

// The narrowest width that cuts nothing off and doesn't wrap the node's text onto more lines than it
// has now, so the node keeps its layout but loses its blank space. When the node has body text, the
// title may take one more line, so a long title doesn't hold the whole node wide. Null if it can't be measured
export function fittedWidth(nodeEl: HTMLElement): number | null {
  const card = nodeEl.querySelector('.study-node') as HTMLElement | null;
  const header = card?.querySelector('.node-header') as HTMLElement | null;
  if (!card || !header) return null;
  const title = card.querySelector('.node-title') as HTMLElement | null;
  const saved = { width: card.style.width, minWidth: card.style.minWidth, minHeight: card.style.minHeight, transition: card.style.transition };
  // Measure the content alone: no resize minimums, and no transition so each width applies at once
  card.style.transition = 'none';
  card.style.minWidth = '0';
  card.style.minHeight = 'auto';

  let high = card.offsetWidth;
  card.style.width = `${high}px`;
  const bodyHeight = textHeight(nodeEl) - header.offsetHeight;
  let headerLimit = header.offsetHeight;
  if (title && card.querySelector('.node-content')) {
    // The title on one line, and the height one more line adds (the title has 2px padding top and bottom)
    card.style.width = 'max-content';
    headerLimit = Math.max(headerLimit, header.offsetHeight + title.offsetHeight - 4);
    card.style.width = `${high}px`;
  }
  // If it's already cut off at this width, widen up to its natural width
  if (overflows(card)) {
    card.style.width = 'max-content';
    high = Math.max(high, card.offsetWidth);
  }

  const fits = (width: number) => {
    card.style.width = `${width}px`;
    const headerHeight = header.offsetHeight;
    return headerHeight <= headerLimit + 1 && textHeight(nodeEl) - headerHeight <= bodyHeight + 1 && !overflows(card);
  };
  let low = 100;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) high = mid; else low = mid;
  }

  Object.assign(card.style, saved);
  return high;
}
