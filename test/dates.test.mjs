import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunDateContext,
  resolveQuestionDateContext,
  formatDateContextForPrompt,
} from '../lib/dates.mjs';

function toMap(resolvedPhrases) {
  return new Map(resolvedPhrases.map(item => [item.phrase.toLowerCase(), item.resolvedDate]));
}

test('following-week mode resolves next weekday phrases from a shared anchor', () => {
  const runDateContext = buildRunDateContext({
    referenceNow: '2026-04-06T12:00:00Z',
    timeZone: 'UTC',
    nextWeekdayMode: 'following-week',
  });

  const questionDateContext = resolveQuestionDateContext(
    'Move it to next Friday, but show me this Wednesday first.',
    runDateContext,
  );

  const resolved = toMap(questionDateContext.resolvedPhrases);
  assert.equal(resolved.get('next friday'), '2026-04-17');
  assert.equal(resolved.get('this wednesday'), '2026-04-08');
});

test('nearest-upcoming mode keeps next weekday on the nearest upcoming date', () => {
  const runDateContext = buildRunDateContext({
    referenceNow: '2026-04-06T12:00:00Z',
    timeZone: 'UTC',
    nextWeekdayMode: 'nearest-upcoming',
  });

  const questionDateContext = resolveQuestionDateContext(
    'Move it to next Friday and remind me tomorrow.',
    runDateContext,
  );

  const resolved = toMap(questionDateContext.resolvedPhrases);
  assert.equal(resolved.get('next friday'), '2026-04-10');
  assert.equal(resolved.get('tomorrow'), '2026-04-07');
});

test('formatted prompt includes resolved date mappings', () => {
  const runDateContext = buildRunDateContext({
    referenceNow: '2026-04-06T12:00:00Z',
    timeZone: 'UTC',
    nextWeekdayMode: 'following-week',
    relativeDateRules: '"next <weekday>" means the following week.',
  });

  const questionDateContext = resolveQuestionDateContext(
    'Set it for next Friday.',
    runDateContext,
  );

  const promptBlock = formatDateContextForPrompt(questionDateContext);
  assert.match(promptBlock, /Current local date: 2026-04-06 \(Monday\)/);
  assert.match(promptBlock, /"next Friday" -> 2026-04-17 \(Friday\)/);
});
