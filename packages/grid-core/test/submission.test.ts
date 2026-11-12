import { REPLACEMENT_ALLOWED_STATUSES, type SubmitOutcome, canSignReplacement } from '../src/submission';

const HASH = 'ab'.repeat(32);

describe('submit outcome', () => {
  it.each<[SubmitOutcome['status'], boolean]>([
    ['success', false],
    ['failed', true],
    ['expired_not_landed', true],
    ['rejected', false],
    ['unknown', false],
  ])('%s allows signing a replacement: %p', (status, allowed) => {
    expect(canSignReplacement({ status })).toBe(allowed);
  });

  it('lists only the statuses where the first transaction can never move money', () => {
    expect([...REPLACEMENT_ALLOWED_STATUSES].sort()).toEqual(['expired_not_landed', 'failed']);
  });

  it('refuses a replacement for a status it does not know', () => {
    expect(canSignReplacement({ status: 'later' as SubmitOutcome['status'] })).toBe(false);
  });

  it('carries a detail only on outcomes other than success', () => {
    const unknown: SubmitOutcome = { status: 'unknown', hash: HASH, detail: { lastError: 'timeout' } };
    // @ts-expect-error a success has nothing more to say than its hash
    const success: SubmitOutcome = { status: 'success', hash: HASH, detail: {} };
    expect([unknown.status, success.status]).toEqual(['unknown', 'success']);
  });
});
