import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTagged } from '../lib/tagged-json.mjs';

test('extractTagged pulls content between matching tags', () => {
  const text = 'preamble\n<FOO>\n{"a": 1}\n</FOO>\npostamble';
  assert.equal(extractTagged(text, 'FOO'), '{"a": 1}');
});

test('extractTagged returns null when tag is missing', () => {
  assert.equal(extractTagged('no tags here', 'FOO'), null);
});

test('extractTagged is case-insensitive on the tag name', () => {
  assert.equal(extractTagged('<foo>bar</foo>', 'FOO'), 'bar');
  assert.equal(extractTagged('<FOO>bar</FOO>', 'foo'), 'bar');
});

test('extractTagged handles multiline content with newlines and embedded JSON', () => {
  const text = '<BAR>\n[\n  { "k": "v" },\n  { "k": "w" }\n]\n</BAR>';
  const inner = extractTagged(text, 'BAR');
  assert.ok(inner);
  const parsed = JSON.parse(inner);
  assert.equal(parsed.length, 2);
});

test('extractTagged returns null when input is not a string', () => {
  assert.equal(extractTagged(null, 'FOO'), null);
  assert.equal(extractTagged(undefined, 'FOO'), null);
  assert.equal(extractTagged(123, 'FOO'), null);
});

test('extractTagged trims whitespace inside the tag', () => {
  assert.equal(extractTagged('<X>   hello world   </X>', 'X'), 'hello world');
});
