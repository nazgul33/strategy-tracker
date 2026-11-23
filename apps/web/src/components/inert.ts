// How many open dialogs hold an element inert, and how many of those have
// lifted it again because they opened inside it. Elements that were inert
// before any dialog (count 0, attribute present) are never touched.
const holds = new WeakMap<Element, number>();
const lifts = new WeakMap<Element, number>();

/** Makes everything outside `overlay` inert until the returned release is called (calling it twice is harmless). */
export function holdBackgroundInert(overlay: Element): () => void {
  const held: Element[] = [];
  const lifted: Element[] = [];

  for (let node: Element = overlay; node !== document.body && node.parentElement !== null; node = node.parentElement) {
    // An older dialog marked this node: this overlay opened inside it, so it
    // must be reachable. Lift the mark for as long as this hold lasts.
    if ((holds.get(node) ?? 0) > 0) {
      lifts.set(node, (lifts.get(node) ?? 0) + 1);
      node.removeAttribute('inert');
      lifted.push(node);
    }
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node) continue;
      const count = holds.get(sibling) ?? 0;
      if (count === 0 && sibling.hasAttribute('inert')) continue; // not ours: leave it as it was
      if (count === 0) sibling.setAttribute('inert', '');
      holds.set(sibling, count + 1);
      held.push(sibling);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const node of held) {
      const left = (holds.get(node) ?? 1) - 1;
      if (left > 0) {
        holds.set(node, left);
      } else {
        holds.delete(node);
        node.removeAttribute('inert');
      }
    }
    for (const node of lifted) {
      const left = (lifts.get(node) ?? 1) - 1;
      if (left > 0) {
        lifts.set(node, left);
      } else {
        lifts.delete(node);
        if ((holds.get(node) ?? 0) > 0) node.setAttribute('inert', '');
      }
    }
  };
}
