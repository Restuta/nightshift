import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseViewContext, viewHref } from '../public/session-view-context.js';

test('context preserves session, cursor, and cutoff and disables live mode', () => {
  const context = parseViewContext('?session=s1&t=100&at=120');

  assert.deepEqual(context, {
    session: 's1',
    cursorT: 100,
    cutoffT: 100,
    asOfT: 120,
    mode: 'replay',
  });
  assert.equal(viewHref('/lanes', context), '/lanes?session=s1&t=100&at=120');
});

test('context accepts URLSearchParams and uses the minimum finite replay boundary', () => {
  const context = parseViewContext(new URLSearchParams('session=space tape&t=240&at=120'));

  assert.deepEqual(context, {
    session: 'space tape',
    cursorT: 240,
    cutoffT: 120,
    asOfT: 120,
    mode: 'replay',
  });
  assert.equal(viewHref('/story', context), '/story?session=space+tape&t=240&at=120');
});

test('either replay parameter disables live mode while invalid values stay out of the cutoff', () => {
  assert.deepEqual(parseViewContext('?session=s1&t=not-a-time'), {
    session: 's1',
    cursorT: null,
    cutoffT: null,
    asOfT: null,
    mode: 'replay',
  });
  assert.deepEqual(parseViewContext('?at=42'), {
    session: null,
    cursorT: null,
    cutoffT: 42,
    asOfT: 42,
    mode: 'replay',
  });
});

test('malformed replay parameters stay replay-only across cross-view navigation', () => {
  for (const search of ['?session=s1&t=bad', '?session=s1&at=bad']) {
    const source = parseViewContext(search);
    const href = viewHref('/story', source);
    const roundTrip = parseViewContext(new URL(href, 'https://nightshift.test').search);

    assert.equal(href, '/story?session=s1&t=');
    assert.equal(roundTrip.mode, 'replay');
    assert.equal(roundTrip.cutoffT, null);
  }
});

test('an empty query stays live and produces a path without a dangling query', () => {
  const context = parseViewContext('');

  assert.deepEqual(context, {
    session: null,
    cursorT: null,
    cutoffT: null,
    asOfT: null,
    mode: 'live',
  });
  assert.equal(viewHref('/graph', context), '/graph');
});
