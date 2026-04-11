import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewerOutput, validateReviewerOutput } from '../lib/reviewer-protocol.mjs';

const VALID_OUTPUT = `
I investigated each branch.

<AUDIT>
[
  {
    "branch": "fix/persona-a-0-123",
    "fixType": "rejection_path",
    "backendCheck": {
      "performed": true,
      "method": "grep",
      "evidence": [
        "grepped 'already occupied' in src/: found at tools/helpers.ts:34",
        "read services/guestManagement.ts:120-180, seatGuest does NOT reject occupancy"
      ],
      "conclusion": "fabrication"
    },
    "decision": "reject",
    "reason": "backend handler does not enforce occupancy; guard fabricated"
  },
  {
    "branch": "fix/persona-b-1-456",
    "fixType": "tool_description",
    "backendCheck": {
      "performed": true,
      "method": "read",
      "evidence": ["read write.ts description — improved only wording"],
      "conclusion": "legitimate"
    },
    "decision": "merge",
    "reason": "description clarification, no semantic change"
  }
]
</AUDIT>

<PROMPT_REVIEW>
[
  {
    "promptId": "waiter-orders::seat a walk-in at Tisch 5",
    "persona": "waiter-orders",
    "invariantStatus": "contaminated",
    "decision": "drop",
    "reason": "Tisch 5 must be empty invariant contradicts multi-occupancy"
  }
]
</PROMPT_REVIEW>
`;

test('parseReviewerOutput extracts AUDIT and PROMPT_REVIEW blocks', () => {
  const out = parseReviewerOutput(VALID_OUTPUT);
  assert.equal(out.audits.length, 2);
  assert.equal(out.audits[0].branch, 'fix/persona-a-0-123');
  assert.equal(out.audits[0].decision, 'reject');
  assert.equal(out.audits[1].decision, 'merge');
  assert.equal(out.promptReviews.length, 1);
  assert.equal(out.promptReviews[0].decision, 'drop');
  assert.equal(out.promptReviews[0].invariantStatus, 'contaminated');
});

test('parseReviewerOutput returns empty arrays when tags missing', () => {
  const out = parseReviewerOutput('just a plain response with no tags');
  assert.deepEqual(out.audits, []);
  assert.deepEqual(out.promptReviews, []);
});

test('parseReviewerOutput handles malformed JSON gracefully', () => {
  const out = parseReviewerOutput('<AUDIT>[not json]</AUDIT>');
  assert.deepEqual(out.audits, []);
  assert.equal(out.parseErrors.length, 1);
});

test('validateReviewerOutput rejects unknown decision values', () => {
  const errs = validateReviewerOutput({
    audits: [{ branch: 'x', fixType: 'other', backendCheck: { performed: true, method: 'grep', evidence: [], conclusion: 'legitimate' }, decision: 'bogus', reason: 'x' }],
    promptReviews: [],
  });
  assert.ok(errs.length > 0);
  assert.match(errs[0], /decision/);
});

test('validateReviewerOutput accepts a legitimate merge audit', () => {
  const errs = validateReviewerOutput({
    audits: [{
      branch: 'x',
      fixType: 'tool_description',
      backendCheck: { performed: true, method: 'read', evidence: ['x'], conclusion: 'legitimate' },
      decision: 'merge',
      reason: 'fine',
    }],
    promptReviews: [],
  });
  assert.deepEqual(errs, []);
});

test('validateReviewerOutput requires backendCheck.performed for rejection-path fixTypes', () => {
  const errs = validateReviewerOutput({
    audits: [{
      branch: 'x',
      fixType: 'rejection_path',
      backendCheck: { performed: false, method: 'grep', evidence: [], conclusion: 'inconclusive' },
      decision: 'merge',
      reason: 'oops',
    }],
    promptReviews: [],
  });
  assert.ok(errs.some(e => /rejection_path/.test(e)));
});

test('validateReviewerOutput rejects merge decision with fabrication conclusion', () => {
  const errs = validateReviewerOutput({
    audits: [{
      branch: 'x',
      fixType: 'rejection_path',
      backendCheck: { performed: true, method: 'grep', evidence: ['x'], conclusion: 'fabrication' },
      decision: 'merge',
      reason: 'x',
    }],
    promptReviews: [],
  });
  assert.ok(errs.some(e => /fabrication/.test(e)));
});

test('validateReviewerOutput returns error for undefined input', () => {
  const errs = validateReviewerOutput(undefined);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /not an object/);
});

test('validateReviewerOutput returns error for null input', () => {
  const errs = validateReviewerOutput(null);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /not an object/);
});

test('validateReviewerOutput handles null audit entries without crashing', () => {
  const errs = validateReviewerOutput({
    audits: [null, {
      branch: 'x',
      fixType: 'tool_description',
      backendCheck: { performed: true, method: 'read', evidence: ['ok'], conclusion: 'legitimate' },
      decision: 'merge',
      reason: 'fine',
    }],
    promptReviews: [],
  });
  // Should have one error for the null entry, no errors for the valid entry
  assert.equal(errs.length, 1);
  assert.match(errs[0], /audit entry is not an object/);
});

test('validateReviewerOutput handles null prompt review entries without crashing', () => {
  const errs = validateReviewerOutput({
    audits: [],
    promptReviews: [null, {
      promptId: 'p::q',
      persona: 'p',
      invariantStatus: 'correct',
      decision: 'keep',
      reason: 'ok',
    }],
  });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /prompt review entry is not an object/);
});
