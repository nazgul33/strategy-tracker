// The bookkeeping behind the dialog's inert background, on a bare DOM (no React).
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

const { holdBackgroundInert } = await import('./inert');

afterAll(() => {
  GlobalRegistrator.unregister();
});

// <body><header/><main><section#card><button#row/><div#slot/></section><aside/></main><footer/></body>
let header: HTMLElement, main: HTMLElement, card: HTMLElement, row: HTMLElement, slot: HTMLElement, aside: HTMLElement, footer: HTMLElement;
const el = (tag: string, parent: Element, id: string) => {
  const node = document.createElement(tag);
  node.id = id;
  parent.appendChild(node);
  return node;
};
const inertIds = () => Array.from(document.querySelectorAll('[inert]')).map((n) => n.id || n.tagName).sort();

beforeEach(() => {
  header = el('header', document.body, 'header');
  main = el('main', document.body, 'main');
  card = el('section', main, 'card');
  row = el('button', card, 'row');
  slot = el('div', card, 'slot');
  aside = el('aside', main, 'aside');
  footer = el('footer', document.body, 'footer');
});

afterEach(() => {
  for (const n of [header, main, footer]) n.remove();
  document.querySelectorAll('[inert]').forEach((n) => n.removeAttribute('inert'));
});

describe('holdBackgroundInert', () => {
  it('marks every sibling along the chain up to body, never the chain or <head>, and release clears them', () => {
    const release = holdBackgroundInert(el('div', slot, 'overlay'));
    expect(inertIds()).toEqual(['aside', 'footer', 'header', 'row']);
    expect(document.head.hasAttribute('inert')).toBe(false);
    release();
    expect(inertIds()).toEqual([]);
  });

  it('leaves an element that was already inert exactly as it was', () => {
    aside.setAttribute('inert', '');
    const release = holdBackgroundInert(el('div', slot, 'overlay'));
    release();
    expect(inertIds()).toEqual(['aside']);
  });

  it('a nested hold adds its own set and gives back only that', () => {
    const outer = el('div', main, 'outer');
    const field = el('input', outer, 'field');
    const releaseOuter = holdBackgroundInert(outer);
    const releaseInner = holdBackgroundInert(el('div', outer, 'inner'));
    expect(inertIds()).toEqual(['aside', 'card', 'field', 'footer', 'header']);
    releaseInner();
    expect(inertIds()).toEqual(['aside', 'card', 'footer', 'header']);
    releaseOuter();
    expect(inertIds()).toEqual([]);
    expect(field.hasAttribute('inert')).toBe(false);
  });

  it('a step swap where the new panel mounts first leaves the newer set, then nothing', () => {
    const a = el('div', slot, 'a');
    const releaseA = holdBackgroundInert(a);
    const b = el('div', slot, 'b');
    const releaseB = holdBackgroundInert(b);
    a.remove();
    releaseA();
    expect(inertIds()).toEqual(['aside', 'footer', 'header', 'row']);
    expect(b.hasAttribute('inert')).toBe(false);
    releaseB();
    expect(inertIds()).toEqual([]);
  });

  it('calling a release twice does not give back another hold', () => {
    const a = el('div', slot, 'a');
    const releaseA = holdBackgroundInert(a);
    const releaseB = holdBackgroundInert(el('div', a, 'b'));
    releaseB();
    releaseB();
    expect(inertIds()).toEqual(['aside', 'footer', 'header', 'row']);
    releaseA();
    expect(inertIds()).toEqual([]);
  });

  it('two sibling overlays held one after the other: the later one stays reachable', () => {
    const a = el('div', slot, 'a');
    const b = el('div', slot, 'b');
    const releaseA = holdBackgroundInert(a);
    const releaseB = holdBackgroundInert(b);
    expect(a.hasAttribute('inert')).toBe(true);
    expect(b.closest('[inert]')).toBeNull();
    releaseB();
    expect(a.hasAttribute('inert')).toBe(false);
    expect(b.hasAttribute('inert')).toBe(true);
    releaseA();
    expect(inertIds()).toEqual([]);
  });

  it('an overlay that opens inside a region another dialog holds inert is lifted out of it, then put back', () => {
    const pageDialog = el('div', main, 'pageDialog'); // e.g. the pool dialog, a sibling of the card
    const releasePage = holdBackgroundInert(pageDialog);
    expect(card.hasAttribute('inert')).toBe(true);
    const late = el('div', slot, 'late'); // a result popup that mounts inside the card afterwards
    const releaseLate = holdBackgroundInert(late);
    expect(late.closest('[inert]')).toBeNull();
    expect(pageDialog.hasAttribute('inert')).toBe(true);
    expect(row.hasAttribute('inert')).toBe(true);
    releaseLate();
    expect(card.hasAttribute('inert')).toBe(true);
    expect(pageDialog.hasAttribute('inert')).toBe(false);
    releasePage();
    expect(inertIds()).toEqual([]);
  });

  it('the older dialog closing first leaves nothing behind once the lifted one closes too', () => {
    const releasePage = holdBackgroundInert(el('div', main, 'pageDialog'));
    const late = el('div', slot, 'late');
    const releaseLate = holdBackgroundInert(late);
    releasePage();
    expect(late.closest('[inert]')).toBeNull();
    expect(inertIds()).toEqual(['aside', 'footer', 'header', 'pageDialog', 'row']);
    releaseLate();
    expect(inertIds()).toEqual([]);
  });
});
