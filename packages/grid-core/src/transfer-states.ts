/**
 * Transfer states and the transition table of a two-leg transfer.
 *
 * ```
 * quoted --> awaiting_pix --> funding --> funded --> payout_quoted
 *   payout_quoted --> payout_processing                (partner-custodied account)
 *   payout_quoted --> awaiting_signature
 *                       --> payout_submitted --> payout_processing   (signed payout flow)
 *   payout_processing --> completed
 * ```
 *
 * `needs_attention` alerts the operators and stops the transfer. Nothing in this
 * table leaves it: the platform never refunds, reroutes or re-signs on its own.
 * A planned step is repeated only while its outcome is still safe, such as a
 * fresh quote or the same idempotent call.
 */
import { InvalidTransitionError } from './errors';

export const TRANSFER_STATES = [
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
] as const;

export type TransferState = (typeof TRANSFER_STATES)[number];

/**
 * End states. `cancelled` is an end state for the normal flow, but a PIX paid
 * after cancellation still moves it to `needs_attention`.
 */
export const TERMINAL_STATES: readonly TransferState[] = ['completed', 'expired', 'cancelled'];

export type TransitionReason =
  | 'funding_leg_created'
  | 'quote_lapsed'
  | 'deposit_detected'
  | 'unpaid_window_elapsed'
  | 'payment_arrived_late'
  | 'usdc_confirmed_in_account'
  | 'funding_failed_or_refunded'
  | 'fresh_quote_within_tolerance'
  | 'quote_outside_tolerance'
  | 'partner_custodied_account'
  | 'signed_payout_flow'
  | 'quote_expired_before_signing'
  | 'signed_and_on_chain'
  | 'partner_accepted'
  | 'partner_refused_or_unknown'
  | 'fiat_landed'
  | 'payout_failed_or_refunded';

export interface TransitionRule {
  readonly from: TransferState;
  readonly to: TransferState;
  readonly reason: TransitionReason;
  readonly label: string;
}

const rule = (
  from: TransferState,
  to: TransferState,
  reason: TransitionReason,
  label: string,
): TransitionRule => ({ from, to, reason, label });

/** Every allowed transition. Any pair not listed here is rejected. */
export const TRANSITIONS: readonly TransitionRule[] = [
  rule('quoted', 'awaiting_pix', 'funding_leg_created', 'funding leg created'),
  rule('quoted', 'expired', 'quote_lapsed', 'quote lapsed'),
  rule('awaiting_pix', 'funding', 'deposit_detected', 'deposit detected'),
  rule('awaiting_pix', 'cancelled', 'unpaid_window_elapsed', 'unpaid window elapsed'),
  rule('cancelled', 'needs_attention', 'payment_arrived_late', 'payment arrived late'),
  rule('funding', 'funded', 'usdc_confirmed_in_account', 'USDC confirmed in account'),
  rule('funding', 'needs_attention', 'funding_failed_or_refunded', 'failed or refunded'),
  rule('funded', 'payout_quoted', 'fresh_quote_within_tolerance', 'fresh quote within tolerance'),
  rule('funded', 'needs_attention', 'quote_outside_tolerance', 'quote outside tolerance'),
  rule('payout_quoted', 'payout_processing', 'partner_custodied_account', 'partner-custodied account'),
  rule('payout_quoted', 'awaiting_signature', 'signed_payout_flow', 'signed payout flow'),
  rule('awaiting_signature', 'funded', 'quote_expired_before_signing', 'quote expired before signing'),
  rule('awaiting_signature', 'payout_submitted', 'signed_and_on_chain', 'signed and on chain'),
  rule('payout_submitted', 'payout_processing', 'partner_accepted', 'partner accepted'),
  rule('payout_submitted', 'needs_attention', 'partner_refused_or_unknown', 'partner refused or unknown'),
  rule('payout_processing', 'completed', 'fiat_landed', 'fiat landed'),
  rule('payout_processing', 'needs_attention', 'payout_failed_or_refunded', 'failed or refunded'),
];

const BY_PAIR: ReadonlyMap<string, TransitionRule> = new Map(
  TRANSITIONS.map((r) => [`${r.from}>${r.to}`, r]),
);

const STATE_SET: ReadonlySet<string> = new Set(TRANSFER_STATES);

export function isTransferState(value: unknown): value is TransferState {
  return typeof value === 'string' && STATE_SET.has(value);
}

export function isTerminal(state: TransferState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** The rule for `from -> to`, or `undefined` when the table does not allow it. */
export function getTransition(from: TransferState, to: TransferState): TransitionRule | undefined {
  return BY_PAIR.get(`${from}>${to}`);
}

export function canTransition(from: TransferState, to: TransferState): boolean {
  return getTransition(from, to) !== undefined;
}

/** States reachable from `from` in one step. */
export function allowedTransitions(from: TransferState): readonly TransferState[] {
  return TRANSITIONS.filter((r) => r.from === from).map((r) => r.to);
}

/**
 * Validates `from -> to` and returns the matching rule.
 * @throws {InvalidTransitionError} when the table does not allow it.
 */
export function transition(from: TransferState, to: TransferState): TransitionRule {
  const found = getTransition(from, to);
  if (found === undefined) throw new InvalidTransitionError(from, to);
  return found;
}
