import test from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentGuideOwner } from '../src/lib/personal-guide-api.mjs';

test('only the current signed-in account can apply its guide UI completion', () => {
  assert.equal(isCurrentGuideOwner('account-a', 'account-a'), true);
  assert.equal(isCurrentGuideOwner('account-b', 'account-a'), false);
  assert.equal(isCurrentGuideOwner(null, 'account-a'), false);
  assert.equal(isCurrentGuideOwner(undefined, undefined), false);
});

test('an aborted load cannot replace the current account directory', () => {
  const controller = new AbortController();
  assert.equal(isCurrentGuideOwner('account-a', 'account-a', controller.signal), true);
  controller.abort();
  assert.equal(isCurrentGuideOwner('account-a', 'account-a', controller.signal), false);
});

test('late save/profile/delete callbacks from A are ignored after B signs in', async () => {
  let owner = 'account-a';
  const aOwner = owner;
  const bState = { guides: ['b-guide'], profile: ['b-fact'], deleted: false };
  let finish;
  const pending = new Promise(resolve => { finish = resolve; }).then(() => {
    if (!isCurrentGuideOwner(owner, aOwner)) return;
    bState.guides = ['a-guide']; bState.profile = ['a-fact']; bState.deleted = true;
  });
  owner = 'account-b'; finish(); await pending;
  assert.deepEqual(bState, { guides: ['b-guide'], profile: ['b-fact'], deleted: false });
});

test('the unchanged account can receive its own delayed response', async () => {
  let saved = false;
  await Promise.resolve().then(() => { if (isCurrentGuideOwner('account-a', 'account-a')) saved = true; });
  assert.equal(saved, true);
});
