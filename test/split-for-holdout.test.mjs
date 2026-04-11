import test from 'node:test';
import assert from 'node:assert/strict';
import { splitForHoldout, hashString, mulberry32 } from '../lib/eval.mjs';

test('hashString is deterministic for the same input', () => {
  assert.equal(hashString('foo'), hashString('foo'));
  assert.notEqual(hashString('foo'), hashString('bar'));
});

test('mulberry32 is deterministic and produces values in [0, 1)', () => {
  const rng1 = mulberry32(42);
  const rng2 = mulberry32(42);
  for (let i = 0; i < 10; i++) {
    const v = rng1();
    assert.equal(v, rng2());
    assert.ok(v >= 0 && v < 1, `value ${v} out of [0,1)`);
  }
});

test('splitForHoldout marks K prompts as holdout and the rest as fixer', () => {
  const prompts = [
    { prompt: 'a', promptObj: {} },
    { prompt: 'b', promptObj: {} },
    { prompt: 'c', promptObj: {} },
  ];
  const split = splitForHoldout(prompts, 1, 'seed-1');
  const holdout = split.filter(p => p.promptObj.evaluation === 'holdout');
  const fixer = split.filter(p => p.promptObj.evaluation === 'fixer');
  assert.equal(holdout.length, 1);
  assert.equal(fixer.length, 2);
  for (const p of split) {
    assert.equal(p.promptObj.lifecycle, 'train');
  }
});

test('splitForHoldout is deterministic for the same seed', () => {
  const make = () => [
    { prompt: 'a', promptObj: {} },
    { prompt: 'b', promptObj: {} },
    { prompt: 'c', promptObj: {} },
    { prompt: 'd', promptObj: {} },
  ];
  const split1 = splitForHoldout(make(), 2, 'same-seed');
  const split2 = splitForHoldout(make(), 2, 'same-seed');
  const key = arr => arr.map(p => `${p.prompt}:${p.promptObj.evaluation}`).join(',');
  assert.equal(key(split1), key(split2));
});

test('splitForHoldout with different seeds yields different splits (usually)', () => {
  const make = () => Array.from({ length: 10 }, (_, i) => ({
    prompt: `p${i}`, promptObj: {},
  }));
  const keyOf = arr => arr.filter(p => p.promptObj.evaluation === 'holdout').map(p => p.prompt).sort().join(',');
  const a = keyOf(splitForHoldout(make(), 3, 'seed-alpha'));
  const b = keyOf(splitForHoldout(make(), 3, 'seed-beta'));
  assert.notEqual(a, b, 'different seeds should produce different holdout selections');
});

test('splitForHoldout with K=0 keeps all prompts as fixer', () => {
  const prompts = [{ prompt: 'a', promptObj: {} }, { prompt: 'b', promptObj: {} }];
  const split = splitForHoldout(prompts, 0, 'seed');
  assert.equal(split.filter(p => p.promptObj.evaluation === 'holdout').length, 0);
  assert.equal(split.filter(p => p.promptObj.evaluation === 'fixer').length, 2);
});

test('splitForHoldout preserves promptObj shape and mutates evaluation/lifecycle in-place', () => {
  const prompts = [
    { prompt: 'a', promptObj: { probe: 'p1', invariant: 'i1', adversarial: false } },
    { prompt: 'b', promptObj: { probe: 'p2', invariant: 'i2', adversarial: true } },
  ];
  const split = splitForHoldout(prompts, 1, 'seed');
  for (const p of split) {
    assert.ok('probe' in p.promptObj);
    assert.ok('invariant' in p.promptObj);
    assert.ok('adversarial' in p.promptObj);
    assert.equal(p.promptObj.lifecycle, 'train');
    assert.ok(['fixer', 'holdout'].includes(p.promptObj.evaluation));
  }
});
