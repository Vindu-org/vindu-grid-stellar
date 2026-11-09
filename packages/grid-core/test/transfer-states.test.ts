import { InvalidTransitionError } from '../src/errors';
import {
  TERMINAL_STATES,
  TRANSFER_STATES,
  TRANSITIONS,
  type TransferState,
  allowedTransitions,
  canTransition,
  getTransition,
  isTerminal,
  isTransferState,
  transition,
} from '../src/transfer-states';

// Written out independently from the source, straight from the state diagram.
const EXPECTED: ReadonlyArray<[TransferState, TransferState, string]> = [
  ['quoted', 'awaiting_pix', 'funding leg created'],
  ['quoted', 'expired', 'quote lapsed'],
  ['awaiting_pix', 'funding', 'deposit detected'],
  ['awaiting_pix', 'cancelled', 'unpaid window elapsed'],
  ['cancelled', 'needs_attention', 'payment arrived late'],
  ['funding', 'funded', 'USDC confirmed in account'],
  ['funded', 'payout_quoted', 'fresh quote within tolerance'],
  ['funded', 'needs_attention', 'quote outside tolerance'],
  ['payout_quoted', 'payout_processing', 'partner-custodied account'],
  ['payout_quoted', 'awaiting_signature', 'signed payout flow'],
  ['awaiting_signature', 'funded', 'quote expired before signing'],
  ['awaiting_signature', 'payout_submitted', 'signed and on chain'],
  ['payout_submitted', 'payout_processing', 'partner accepted'],
  ['payout_submitted', 'needs_attention', 'partner refused or unknown'],
  ['payout_processing', 'completed', 'fiat landed'],
  ['payout_processing', 'needs_attention', 'failed or refunded'],
  ['funding', 'needs_attention', 'failed or refunded'],
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

const allowed = new Map(EXPECTED.map(([f, t, label]) => [`${f}>${t}`, label]));
const allPairs = TRANSFER_STATES.flatMap((from) => TRANSFER_STATES.map((to) => [from, to] as const));

describe('transitions', () => {
  it('has exactly the twelve states of the spec', () => {
    expect([...TRANSFER_STATES].sort()).toEqual([...EXPECTED_STATES].sort());
  });

  it('table has exactly the expected transitions, no more, no fewer', () => {
    const actual = TRANSITIONS.map((r) => `${r.from}>${r.to}`).sort();
    expect(actual).toEqual([...allowed.keys()].sort());
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('checks all 144 state pairs', () => {
    expect(allPairs).toHaveLength(144);
  });

  it.each(allPairs)('%s -> %s matches the table', (from, to) => {
    const label = allowed.get(`${from}>${to}`);
    if (label === undefined) {
      expect(canTransition(from, to)).toBe(false);
      expect(getTransition(from, to)).toBeUndefined();
      expect(() => transition(from, to)).toThrow(InvalidTransitionError);
    } else {
      expect(canTransition(from, to)).toBe(true);
      const r = transition(from, to);
      expect(r).toMatchObject({ from, to, label });
      expect(r.reason).toMatch(/^[a-z_]+$/);
    }
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
