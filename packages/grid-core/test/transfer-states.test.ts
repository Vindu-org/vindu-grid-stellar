import { InvalidTransitionError } from '../src/errors';
import {
  TERMINAL_STATES,
  TRANSFER_STATES,
  TRANSITIONS,
  type TransferState,
  type TransitionReason,
  allowedTransitions,
  canTransition,
  getTransition,
  isTerminal,
  isTransferState,
  transition,
  transitionRules,
} from '../src/transfer-states';

// Written out independently from the source, straight from the state diagram
// and the failure handling table: [from, to, reason, label].
const EXPECTED: ReadonlyArray<[TransferState, TransferState, TransitionReason, string]> = [
  ['quoted', 'awaiting_pix', 'funding_leg_created', 'funding leg created'],
  ['quoted', 'expired', 'quote_lapsed', 'quote lapsed'],
  ['awaiting_pix', 'funding', 'deposit_detected', 'deposit detected'],
  ['awaiting_pix', 'cancelled', 'unpaid_window_elapsed', 'unpaid window elapsed'],
  ['cancelled', 'needs_attention', 'payment_arrived_late', 'payment arrived late'],
  ['funding', 'funded', 'usdc_confirmed_in_account', 'USDC confirmed in account'],
  ['funded', 'payout_quoted', 'fresh_quote_within_tolerance', 'fresh quote within tolerance'],
  ['funded', 'needs_attention', 'quote_outside_tolerance', 'quote outside tolerance'],
  ['payout_quoted', 'payout_processing', 'partner_custodied_account', 'partner-custodied account'],
  ['payout_quoted', 'awaiting_signature', 'signed_payout_flow', 'signed payout flow'],
  ['awaiting_signature', 'funded', 'quote_expired_before_signing', 'quote expired before signing'],
  ['awaiting_signature', 'payout_submitted', 'signed_and_on_chain', 'signed and on chain'],
  ['payout_submitted', 'payout_processing', 'partner_accepted', 'partner accepted'],
  ['payout_submitted', 'needs_attention', 'partner_refused_or_unknown', 'partner refused or unknown'],
  ['payout_processing', 'completed', 'fiat_landed', 'fiat landed'],
  ['payout_processing', 'needs_attention', 'payout_failed_or_refunded', 'failed or refunded'],
  ['funding', 'needs_attention', 'funding_failed_or_refunded', 'failed or refunded'],
  // Failure edges from the failure handling table.
  ['funded', 'needs_attention', 'payout_quote_failed', 'payout quote failed after retries'],
  ['payout_quoted', 'funded', 'quote_expired_before_authorization', 'quote expired before authorization'],
  ['payout_quoted', 'needs_attention', 'authorization_failed', 'authorization failed'],
  ['awaiting_signature', 'needs_attention', 'submission_rejected_or_unknown', 'submission rejected or outcome unknown'],
  ['awaiting_signature', 'needs_attention', 'signer_refused', 'signer refused the transaction'],
  // The payout create failing on the paths that have no payout_submitted yet.
  ['payout_quoted', 'needs_attention', 'payout_create_failed', 'payout create failed'],
  ['awaiting_signature', 'needs_attention', 'partner_submission_unknown', 'signed XDR sent, partner did not confirm'],
  // partner_submits success: the partner has the signed XDR, nobody saw it on chain yet.
  ['awaiting_signature', 'payout_submitted', 'sent_to_partner', 'signed XDR handed to the partner'],
  // Anything that stops a run after onAuthorized and has no edge of its own.
  ['awaiting_signature', 'needs_attention', 'run_interrupted', 'payout run interrupted after authorization'],
];

const EXPECTED_STATES = [
  'quoted',
  'awaiting_pix',
  'funding',
  'funded',
  'payout_quoted',
  'awaiting_signature',
  'payout_submitted',
  'payout_processing',
  'completed',
  'needs_attention',
  'expired',
  'cancelled',
];

const byPair = new Map<string, Array<[TransitionReason, string]>>();
for (const [f, t, reason, label] of EXPECTED) {
  byPair.set(`${f}>${t}`, [...(byPair.get(`${f}>${t}`) ?? []), [reason, label]]);
}
const allPairs = TRANSFER_STATES.flatMap((from) => TRANSFER_STATES.map((to) => [from, to] as const));

describe('transitions', () => {
  it('has exactly the twelve states of the spec', () => {
    expect([...TRANSFER_STATES].sort()).toEqual([...EXPECTED_STATES].sort());
  });

  it('table has exactly the expected rules, no more, no fewer', () => {
    const actual = TRANSITIONS.map((r) => `${r.from}>${r.to}>${r.reason}>${r.label}`).sort();
    expect(actual).toEqual(EXPECTED.map((e) => e.join('>')).sort());
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('gives every rule its own reason code', () => {
    const reasons = TRANSITIONS.map((r) => r.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const r of reasons) expect(r).toMatch(/^[a-z_]+$/);
  });

  it('checks all 144 state pairs', () => {
    expect(allPairs).toHaveLength(144);
  });

  it.each(allPairs)('%s -> %s matches the table', (from, to) => {
    const expected = byPair.get(`${from}>${to}`) ?? [];
    expect(canTransition(from, to)).toBe(expected.length > 0);
    expect(transitionRules(from, to).map((r) => [r.reason, r.label])).toEqual(expected);
    if (expected.length === 0) {
      expect(getTransition(from, to)).toBeUndefined();
      expect(() => transition(from, to)).toThrow(InvalidTransitionError);
      return;
    }
    for (const [reason, label] of expected) {
      expect(transition(from, to, reason)).toMatchObject({ from, to, reason, label });
      expect(getTransition(from, to, reason)).toMatchObject({ reason, label });
    }
    if (expected.length === 1) {
      expect(transition(from, to)).toMatchObject({ from, to, label: expected[0]?.[1] });
    } else {
      // Several rules: the caller must say which, so the history records why.
      expect(getTransition(from, to)).toBeUndefined();
      expect(() => transition(from, to)).toThrow(/needs a reason/);
    }
  });

  it('refuses a reason the pair does not list', () => {
    expect(() => transition('funded', 'payout_quoted', 'payout_quote_failed')).toThrow(InvalidTransitionError);
    expect(() => transition('funded', 'payout_quoted', 'payout_quote_failed')).toThrow(/payout_quote_failed/);
    expect(getTransition('funded', 'payout_quoted', 'payout_quote_failed')).toBeUndefined();
  });

  it('names the choices when a pair needs a reason', () => {
    try {
      transition('funded', 'needs_attention');
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toMatchObject({
        code: 'invalid_transition',
        choices: ['quote_outside_tolerance', 'payout_quote_failed'],
      });
    }
  });

  it('lists each reachable state once', () => {
    expect(allowedTransitions('funded')).toEqual(['payout_quoted', 'needs_attention']);
    expect(allowedTransitions('payout_quoted')).toEqual([
      'payout_processing',
      'awaiting_signature',
      'funded',
      'needs_attention',
    ]);
  });

  it('never re-signs on its own: no edge from a submitted payout back to signing', () => {
    expect(allowedTransitions('payout_submitted')).not.toContain('awaiting_signature');
    expect(allowedTransitions('payout_submitted')).not.toContain('funded');
    expect(allowedTransitions('awaiting_signature')).not.toContain('awaiting_signature');
  });

  it('throws a typed error carrying both states', () => {
    try {
      transition('completed', 'quoted');
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      expect(e).toMatchObject({ code: 'invalid_transition', from: 'completed', to: 'quoted' });
    }
  });

  it('needs_attention has no way out', () => {
    expect(allowedTransitions('needs_attention')).toEqual([]);
  });

  it('completed and expired have no way out; cancelled only to needs_attention', () => {
    expect(TERMINAL_STATES).toEqual(['completed', 'expired', 'cancelled']);
    expect(allowedTransitions('completed')).toEqual([]);
    expect(allowedTransitions('expired')).toEqual([]);
    expect(allowedTransitions('cancelled')).toEqual(['needs_attention']);
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('needs_attention')).toBe(false);
  });

  it('uses public wording for the payout branches', () => {
    const labels = TRANSITIONS.map((r) => r.label).join('|');
    expect(labels).not.toMatch(/wallet|stellar/i);
  });

  it('recognises states at runtime', () => {
    expect(isTransferState('funded')).toBe(true);
    expect(isTransferState('refunded')).toBe(false);
    expect(isTransferState(42)).toBe(false);
  });
});
