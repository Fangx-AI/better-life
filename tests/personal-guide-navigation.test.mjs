import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuideNavigationGuard, validatePersonalGuideCorpus } from '../src/lib/personal-guide-navigation.mjs';

function fixture() {
  const events = new Map(), documentEvents = new Map(), stack = [{ state: { unrelated: 42 }, url: 'https://life.example/?view=guides' }];
  let position = 0, pending = false, accepted = false, confirms = 0;
  const navigations = [], traversals = [];
  const win = {
    location: { href: stack[0].url }, crypto: { randomUUID: () => 'page-token' },
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
    document: { addEventListener: (name, fn) => documentEvents.set(name, fn), removeEventListener: name => documentEvents.delete(name) },
    setTimeout: () => {},
    history: {
      get state() { return stack[position].state; },
      replaceState(state, _, url) { stack[position] = { state, url }; win.location.href = url; },
      pushState(state, _, url) { stack.splice(position + 1); stack.push({ state, url }); position += 1; win.location.href = url; },
      go(delta) { traversals.push(delta); position += delta; win.location.href = stack[position].url; events.get('popstate')?.({ state: stack[position].state }); },
    },
  };
  const guard = createGuideNavigationGuard({ window: win, hasPending: () => pending, confirm: () => { confirms += 1; return accepted; }, onNavigate: url => navigations.push(url) });
  return { win, guard, stack, events, documentEvents, traversals, navigations, dirty: value => { pending = value; }, accept: value => { accepted = value; }, confirms: () => confirms };
}

test('rejecting browser back restores the same entry once, without adding history or exposing drafts', () => {
  const f = fixture(); f.guard.push('?view=guides&guide=my-note'); const originalLength = f.stack.length;
  f.dirty(true); f.win.history.go(-1);
  assert.equal(f.win.location.href, 'https://life.example/?view=guides&guide=my-note');
  assert.deepEqual(f.traversals, [-1, 1]); assert.equal(f.confirms(), 1);
  assert.equal(f.navigations.length, 1); assert.equal(f.stack.length, originalLength);
  assert.equal(f.win.history.state.unrelated, 42);
  assert.deepEqual(Object.keys(f.win.history.state).sort(), ['__betterLifeGuideNavigation', 'unrelated']);
});

test('confirming back navigates, and rejecting forward similarly restores the prior entry', () => {
  const f = fixture(); f.guard.push('?view=guides&guide=my-note'); f.dirty(true); f.accept(true); f.win.history.go(-1);
  assert.equal(f.navigations.at(-1), 'https://life.example/?view=guides');
  f.accept(false); f.win.history.go(1);
  assert.equal(f.win.location.href, 'https://life.example/?view=guides'); assert.deepEqual(f.traversals, [-1, 1, -1]);
});

test('saved changes do not block traversal and explicit created/deleted transitions can bypass obsolete dirty flags', () => {
  const f = fixture(); f.guard.push('?view=guides&guide=my-note'); f.dirty(true);
  assert.equal(f.guard.push('?view=guides'), false);
  f.dirty(false); f.win.history.go(-1); assert.equal(f.confirms(), 1);
  f.dirty(true); assert.equal(f.guard.push('?view=guides&guide=created', { confirmed: true }), true); assert.equal(f.confirms(), 1);
});

test('leaving link cancellation and unload warning protect content, while download/new-tab keep the page', () => {
  const f = fixture(); f.dirty(true);
  const link = { href: 'https://life.example/', target: '', hasAttribute: () => false };
  let prevented = 0;
  const event = { target: { closest: () => link }, button: 0, preventDefault: () => { prevented += 1; }, stopPropagation: () => {} };
  f.documentEvents.get('click')(event); assert.equal(prevented, 1);
  link.target = '_blank'; f.documentEvents.get('click')(event); assert.equal(prevented, 1);
  link.target = ''; link.hasAttribute = () => true; f.documentEvents.get('click')(event); assert.equal(prevented, 1);
  const unload = { preventDefault: () => { prevented += 1; } }; f.events.get('beforeunload')(unload); assert.equal(unload.returnValue, '');
  f.guard.dispose(); assert.equal(f.events.size, 0); assert.equal(f.documentEvents.size, 0);
});

test('unmanaged same-document destinations restore the URL without recursive traversals', () => {
  const f = fixture(); f.dirty(true); f.win.location.href = 'https://life.example/?view=guides#other';
  f.events.get('popstate')({ state: null }); assert.equal(f.win.location.href, 'https://life.example/?view=guides'); assert.deepEqual(f.traversals, []);
});

test('corpus load accepts the actual rendering shape and rejects malformed responses for a visible retry', () => {
  const valid = { source: { snapshotDate: '2026-10-03' }, chapters: [{ entries: [{ id: '15-1', title: '租房' }] }] };
  assert.equal(validatePersonalGuideCorpus(valid), valid);
  for (const invalid of [null, {}, { chapters: [] }, { ...valid, chapters: [{ entries: null }] }, { ...valid, chapters: [{ entries: [null] }] }, { ...valid, source: {} }]) assert.throws(() => validatePersonalGuideCorpus(invalid), /原文/);
});
