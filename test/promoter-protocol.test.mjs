import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePromoterOutput, validatePromoterOutput } from '../lib/promoter-protocol.mjs';

test('parsePromoterOutput extracts NOMINATIONS and SKIPPED tagged blocks', () => {
  const text = [
    'Some reasoning text from the LLM',
    '',
    '<NOMINATIONS>',
    '[',
    '  {',
    '    "promptId": "waiter::seat walk-in at Tisch 3",',
    '    "capabilityTag": "walk-in-seating",',
    '    "confidence": "high",',
    '    "reason": "unique, passes cleanly, exercises multi-occupancy"',
    '  }',
    ']',
    '</NOMINATIONS>',
    '',
    '<SKIPPED>',
    '[',
    '  { "promptId": "waiter::list tables", "reason": "duplicate of existing golden" }',
    ']',
    '</SKIPPED>',
  ].join('\n');
  const parsed = parsePromoterOutput(text);
  assert.equal(parsed.nominations.length, 1);
  assert.equal(parsed.nominations[0].promptId, 'waiter::seat walk-in at Tisch 3');
  assert.equal(parsed.skipped.length, 1);
  assert.equal(parsed.parseErrors.length, 0);
});

test('parsePromoterOutput reports parse errors for invalid JSON but does not throw', () => {
  const text = '<NOMINATIONS>\n[ this is not valid JSON ]\n</NOMINATIONS>';
  const parsed = parsePromoterOutput(text);
  assert.equal(parsed.nominations.length, 0);
  assert.ok(parsed.parseErrors.length >= 1);
  assert.match(parsed.parseErrors[0], /NOMINATIONS parse failed/);
});

test('parsePromoterOutput returns empty arrays when tags are missing', () => {
  const parsed = parsePromoterOutput('no tags at all');
  assert.deepEqual(parsed.nominations, []);
  assert.deepEqual(parsed.skipped, []);
  assert.deepEqual(parsed.parseErrors, []);
});

test('parsePromoterOutput handles non-string input safely', () => {
  const parsed = parsePromoterOutput(null);
  assert.deepEqual(parsed.nominations, []);
  assert.deepEqual(parsed.skipped, []);
});

test('validatePromoterOutput accepts a well-formed nomination', () => {
  const errors = validatePromoterOutput({
    nominations: [{
      promptId: 'p::q', capabilityTag: 'tag', confidence: 'high', reason: 'r',
    }],
    skipped: [],
  });
  assert.deepEqual(errors, []);
});

test('validatePromoterOutput rejects unknown confidence values', () => {
  const errors = validatePromoterOutput({
    nominations: [{ promptId: 'p::q', capabilityTag: 'tag', confidence: 'certain', reason: 'r' }],
    skipped: [],
  });
  assert.ok(errors.some(e => /confidence/.test(e)));
});

test('validatePromoterOutput rejects missing promptId in nomination', () => {
  const errors = validatePromoterOutput({
    nominations: [{ capabilityTag: 'tag', confidence: 'high', reason: 'r' }],
    skipped: [],
  });
  assert.ok(errors.some(e => /promptId/.test(e)));
});

test('validatePromoterOutput rejects missing reason in skipped entry', () => {
  const errors = validatePromoterOutput({
    nominations: [],
    skipped: [{ promptId: 'p::q' }],
  });
  assert.ok(errors.some(e => /reason/.test(e)));
});

test('validatePromoterOutput handles null and non-object inputs', () => {
  assert.deepEqual(validatePromoterOutput(null), ['validatePromoterOutput: parsed input is not an object']);
  assert.deepEqual(validatePromoterOutput(undefined), ['validatePromoterOutput: parsed input is not an object']);
});

test('validatePromoterOutput skips null nomination entries with a clear error', () => {
  const errors = validatePromoterOutput({ nominations: [null], skipped: [] });
  assert.ok(errors.some(e => /nomination entry is not an object/.test(e)));
});
