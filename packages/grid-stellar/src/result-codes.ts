/**
 * Horizon result codes, mapped to typed submission errors.
 *
 * Only the short result codes travel (`tx_bad_seq`, `op_underfunded`): never
 * the envelope, the result XDR or any other part of Horizon's payload.
 */

export type SubmitErrorCode =
  /** The sequence number is not the account's next one. */
  | 'bad_seq'
  /** The transaction's maxTime has passed. */
  | 'too_late'
  /** The transaction's minTime has not been reached. */
  | 'too_early'
  | 'insufficient_fee'
  /** The fee would take the source account below its minimum balance. */
  | 'insufficient_balance'
  /** Missing or wrong signatures. */
  | 'bad_auth'
  /** The source account does not exist. */
  | 'no_account'
  | 'malformed'
  /** The sender does not hold enough of the asset. */
  | 'underfunded'
  /** The destination has no trustline for the asset. */
  | 'no_trust'
  /** The sender has no trustline for the asset. */
  | 'src_no_trust'
  /** The issuer has not authorised the trustline. */
  | 'not_authorized'
  | 'src_not_authorized'
  /** The destination account does not exist. */
  | 'no_destination'
  /** The destination's trustline limit would be exceeded. */
  | 'line_full'
  | 'no_issuer'
  /** A path payment could not cross the order book within its limits. */
  | 'path_failed'
  /** The transaction failed without a more specific code. */
  | 'failed'
  | 'other';

export interface SubmitError {
  readonly code: SubmitErrorCode;
  /** Horizon's transaction code, e.g. `tx_bad_seq`. */
  readonly transactionCode?: string;
  /** Horizon's operation codes, e.g. `['op_success', 'op_underfunded']`. */
  readonly operationCodes: readonly string[];
}

const TX_CODES: Readonly<Record<string, SubmitErrorCode>> = {
  tx_bad_seq: 'bad_seq',
  tx_too_late: 'too_late',
  tx_too_early: 'too_early',
  tx_insufficient_fee: 'insufficient_fee',
  tx_insufficient_balance: 'insufficient_balance',
  tx_bad_auth: 'bad_auth',
  tx_bad_auth_extra: 'bad_auth',
  tx_no_source_account: 'no_account',
  tx_malformed: 'malformed',
  tx_missing_operation: 'malformed',
  tx_bad_min_seq_age_or_gap: 'bad_seq',
};

const OP_CODES: Readonly<Record<string, SubmitErrorCode>> = {
  op_underfunded: 'underfunded',
  op_no_trust: 'no_trust',
  op_src_no_trust: 'src_no_trust',
  op_not_authorized: 'not_authorized',
  op_src_not_authorized: 'src_not_authorized',
  op_no_destination: 'no_destination',
  op_line_full: 'line_full',
  op_no_issuer: 'no_issuer',
  op_malformed: 'malformed',
  op_bad_auth: 'bad_auth',
  op_no_account: 'no_account',
  op_too_few_offers: 'path_failed',
  op_over_source_max: 'path_failed',
  op_under_dest_min: 'path_failed',
  op_cross_self: 'path_failed',
};

const CODE_RE = /^(tx|op)_[a-z_]{1,48}$/;

/**
 * Maps Horizon's `result_codes` to a {@link SubmitError}. Transaction-level
 * codes win, except `tx_failed` (and a failed fee-bump inner transaction),
 * where the first failing operation decides. Strings that do not look like
 * result codes are dropped.
 */
export function mapResultCodes(transactionCode: string | undefined, operationCodes: readonly string[] = []): SubmitError {
  const tx = transactionCode !== undefined && CODE_RE.test(transactionCode) ? transactionCode : undefined;
  const ops = operationCodes.filter((c) => CODE_RE.test(c));
  const base = { ...(tx === undefined ? {} : { transactionCode: tx }), operationCodes: ops };

  if (tx !== undefined && tx !== 'tx_failed' && tx !== 'tx_fee_bump_inner_failed') {
    return { code: TX_CODES[tx] ?? 'other', ...base };
  }
  const failing = ops.find((c) => c !== 'op_success');
  if (failing !== undefined) return { code: OP_CODES[failing] ?? 'other', ...base };
  return { code: tx === undefined ? 'other' : 'failed', ...base };
}
