/**
 * Leg two: USDC from the client's Stellar account to USD by wire, through
 * the supported signed payout path: core's `runSignedPayout` with
 * grid-stellar's `createStellarSubmitter`.
 *
 * funded -> payout_quoted -> awaiting_signature -> payout_submitted
 *   -> payout_processing -> completed
 *
 * The fresh payout quote must be within the price tolerance of the estimate
 * the client saw. The flow runs from `payout_quoted`: the partner authorizes
 * and returns an unsigned transaction, and only then does the transfer move
 * to `awaiting_signature` (in `onAuthorized`). The signer checks the
 * transaction before signing, once; the signed transaction is submitted with
 * the hash checked before any retry; only a confirmed success lets the
 * partner payout be created.
 *
 * Where the flow can stop, the transfer takes the failure edge from core's
 * table, and nothing is re-signed, refunded or rerouted automatically:
 * - the payout quote fails: `funded -> needs_attention` (payout_quote_failed);
 * - the quote is outside tolerance: `funded -> needs_attention` (quote_outside_tolerance);
 * - the quote gets too close to expiry before the partner authorizes:
 *   `payout_quoted -> funded` (quote_expired_before_authorization);
 * - the partner's authorization fails: `payout_quoted -> needs_attention`
 *   (authorization_failed), nothing was signed;
 * - the quote gets too close to expiry after that, before the transaction
 *   leaves: `awaiting_signature -> funded` (quote_expired_before_signing),
 *   nothing was submitted;
 * - the signer refuses or fails: `awaiting_signature -> needs_attention` (signer_refused);
 * - the submit outcome is anything but `success`: `awaiting_signature -> needs_attention`;
 * - the partner does not take the payout: `payout_submitted -> needs_attention`;
 * - the payout is not on chain as signed, or does not land:
 *   `payout_processing -> needs_attention`.
 */
import {
  type LegQuote,
  type LogFields,
  type Logger,
  type Money,
  PayoutAuthorizationError,
  PayoutIncompleteError,
  QuoteExpiredError,
  type SignedPayoutContext,
  type SignedPayoutResult,
  SignerRefusedError,
  SigningNotAllowedError,
  type StellarSubmitter,
  checkPayoutTolerance,
  runSignedPayout,
  signingContextFor,
} from '@vindu/grid-core';
import { createStellarSubmitter } from '@vindu/grid-stellar';

import { describeMatch } from './chain-watch';
import { fmt, short } from './format';
import type { LegContext } from './leg-context';
import { Keypair } from './sdk';
import { buildPaymentXdr } from './stellar-tx';
import type { Transfer } from './transfer';
import { USD } from './world';

/** How far the payout quote may move from the estimate, in basis points. */
export const PAYOUT_TOLERANCE_BPS = 30;

export interface PayoutOptions {
  /** Make Horizon time out once on the payout submission, to show the hash check. */
  readonly simulateHorizonTimeout: boolean;
  /** Make Horizon refuse the payout submission, to show the failure edge. */
  readonly simulateSubmitRejection?: boolean;
  /** Make the partner refuse to authorize the payout, to show that failure edge. */
  readonly simulateAuthorizationFailure?: boolean;
}

/** Returns the payout transaction hash, or `undefined` when the transfer stopped short of `completed`. */
export async function runPayoutLeg(
  ctx: LegContext,
  funded: Money,
  estimate: Money,
  options: PayoutOptions,
): Promise<string | undefined> {
  const { world, transfer, log } = ctx;
  const { partner, signer, ledger, networkPassphrase } = world;

  // 1. A fresh payout quote, checked against the estimate the client saw.
  let quote: LegQuote;
  try {
    quote = await partner.quotePayout({
      customerId: ctx.customerId,
      account: ctx.account,
      source: funded,
      targetAsset: USD,
      rail: 'wire',
      beneficiaryId: 'demo-beneficiary',
    });
  } catch (e) {
    transfer.move('needs_attention', `no payout quote (${message(e)}); the USDC stays in the account`, 'payout_quote_failed');
    return undefined;
  }
  log(`    payout quote ${quote.id}: ${fmt(quote.source)} -> ${fmt(quote.target)}`);
  const tolerance = checkPayoutTolerance(estimate, quote.target, PAYOUT_TOLERANCE_BPS);
  const gap = `${tolerance.deviationBps} bps from the estimate ${fmt(estimate)}, tolerance ${PAYOUT_TOLERANCE_BPS} bps`;
  if (!tolerance.ok) {
    transfer.move(tolerance.nextState, `${fmt(quote.target)} is ${gap}; the USDC stays in the account`, tolerance.reason);
    return undefined;
  }
  transfer.move('payout_quoted', `${fmt(quote.target)} is ${gap}`);

  // What runSignedPayout and the signer compare the transaction with. The
  // run starts here, in payout_quoted.
  const payoutContext: SignedPayoutContext = {
    transferId: transfer.id,
    state: 'payout_quoted',
    quote,
    account: ctx.account,
  };
  const destination = partner.treasuryAddress;
  const submitterOptions = {
    gateway: ledger,
    networkPassphrase,
    now: ctx.now,
    sleep: async () => undefined,
    logger: printingLogger(log),
  };

  // 2. The signer checks what it signs. Asked too early, it refuses; nothing is signed.
  const stranger = await xdrPayingAnotherAccount(ctx, quote);
  await expectRefusal(log, 'asked to sign before awaiting_signature', () =>
    signer.signStellar(ctx.account, stranger, signingContextFor({ ...payoutContext, destination }, transfer.state)),
  );

  // 3. The real run: authorize, move to awaiting_signature, sign once,
  // submit, then the partner payout.
  if (options.simulateAuthorizationFailure === true) {
    partner.refuseNextAuthorization();
    log('    (the partner is set to refuse the payout authorization)');
  }
  if (options.simulateHorizonTimeout) {
    ledger.timeOutNextSubmission();
    log('    (Horizon is set to time out on this submission, after the transaction lands)');
  }
  if (options.simulateSubmitRejection === true) {
    ledger.rejectNextSubmission();
    log('    (Horizon is set to refuse this submission)');
  }
  const stellar = createStellarSubmitter(submitterOptions);
  const before = { submissions: ledger.submissions.length, lookups: ledger.lookups.length };
  // Prints what the submit found; the transfer moves only in onSubmitted.
  const submitter: StellarSubmitter = {
    async submit(signedXdr) {
      const outcome = await stellar.submit(signedXdr);
      log(
        `    submit: ${outcome.status}, tx ${short(outcome.hash)}; ` +
          `${ledger.submissions.length - before.submissions} submission(s), ` +
          `${ledger.lookups.length - before.lookups} hash lookup(s), no second signature`,
      );
      return outcome;
    },
  };

  let result: SignedPayoutResult;
  try {
    result = await runSignedPayout({
      adapter: partner,
      context: payoutContext,
      // The funding leg's confirmed amount: the quote may not move more.
      funded,
      now: ctx.now,
      idempotencyKey: `${transfer.id}:payout`,
      signing: {
        signer,
        submitter,
        submission: 'client_submits',
        destination,
        // The partner authorized: store awaiting_signature before anything is signed.
        onAuthorized: async () => {
          transfer.move('awaiting_signature', `${partner.id} pays out from the client's own account, so the client's key holder signs`);
          // A transaction that pays someone other than the partner is refused.
          await expectRefusal(log, 'XDR that pays another account', () =>
            signer.signStellar(ctx.account, stranger, signingContextFor({ ...payoutContext, destination }, transfer.state)),
          );
          return transfer.state;
        },
        onSigned: () =>
          log(
            `    signer (${signer.custody}) checked state, expiry, source and operation source, destination, ` +
              'asset, amount, fee and maxTime, then signed once; the signed XDR is stored before it leaves',
          ),
        // The money moved: the transfer is payout_submitted before the partner hears about it.
        onSubmitted: (outcome) => {
          transfer.move('payout_submitted', `tx ${short(outcome.hash)} confirmed on the ledger`);
        },
      },
    });
  } catch (e) {
    stopPayout(transfer, e);
    return undefined;
  }

  // 4. The partner took the signed transaction and its hash.
  const accepted = await partner.readLeg(result.leg);
  if (accepted.status !== 'processing' && accepted.status !== 'completed') {
    transfer.move('needs_attention', `${partner.id} reports payout ${accepted.status}`, 'partner_refused_or_unknown');
    return undefined;
  }
  transfer.move('payout_processing', `${partner.id} accepted payout ${result.leg.id}`);

  // 5. The read layer resumes from its cursor and sees the outgoing payment.
  const poll = await ctx.watch.poll();
  log(`    read layer: ${poll.fresh.length} new payment(s), cursor ${poll.from ?? 'start'} -> ${poll.to ?? 'start'}`);
  const payment = poll.fresh.find((p) => p.direction === 'outgoing');
  const match =
    payment === undefined
      ? { matched: false, text: 'no outgoing payment on chain' }
      : describeMatch(payment, [
          {
            legId: `${transfer.id}/payout`,
            destination: partner.treasuryAddress,
            source: ctx.account.address,
            amount: quote.source,
            ...(result.txHash === undefined ? {} : { txHash: result.txHash }),
            reference: quote.id,
          },
        ]);
  log(`    ${match.text}`);
  if (!match.matched) {
    transfer.move('needs_attention', 'the payout is not on chain as signed');
    return undefined;
  }

  log('    (the beneficiary bank receives the wire)');
  partner.simulateFiatLanded(result.leg.id);
  const landed = await partner.readLeg(result.leg);
  if (landed.status !== 'completed') {
    transfer.move('needs_attention', `${partner.id} reports payout ${landed.status}`);
    return undefined;
  }
  transfer.move('completed', `${fmt(landed.amount ?? quote.target)} delivered by wire`);
  return result.txHash;
}

/**
 * Moves the transfer along the failure edge for an error from
 * `runSignedPayout`, or rethrows an error the demo does not expect.
 */
function stopPayout(transfer: Transfer, e: unknown): void {
  const from = transfer.state;
  if (e instanceof QuoteExpiredError && e.stage === 'authorization' && from === 'payout_quoted') {
    transfer.move('funded', `${e.message}; nothing was authorized, get a fresh quote`, 'quote_expired_before_authorization');
    return;
  }
  if (e instanceof PayoutAuthorizationError && from === 'payout_quoted') {
    transfer.move('needs_attention', `${e.message}; the USDC stays in the account`, 'authorization_failed');
    return;
  }
  if (e instanceof QuoteExpiredError && e.stage === 'signing' && from === 'awaiting_signature') {
    transfer.move('funded', `${e.message}; nothing was submitted, get a fresh quote`, 'quote_expired_before_signing');
    return;
  }
  if (e instanceof SignerRefusedError && from === 'awaiting_signature') {
    transfer.move('needs_attention', `${e.message}; the USDC stays in the account`, 'signer_refused');
    return;
  }
  if (e instanceof PayoutIncompleteError && e.stage === 'record' && from === 'awaiting_signature') {
    // The money moved but was not recorded: record it now, then the create is retried, never re-quoted.
    transfer.move('payout_submitted', `tx ${short(e.txHash ?? '')} is on the ledger; retry the create with the stored body and key`, 'signed_and_on_chain');
    return;
  }
  if (e instanceof PayoutIncompleteError && e.stage === 'submit' && from === 'awaiting_signature') {
    const tx = e.txHash === undefined ? '' : ` tx ${short(e.txHash)}`;
    transfer.move(
      'needs_attention',
      `submit ended ${e.outcome?.status ?? 'without an outcome'}; check${tx} on Stellar, do not sign again`,
      'submission_rejected_or_unknown',
    );
    return;
  }
  if (e instanceof PayoutIncompleteError && e.stage === 'create' && from === 'payout_submitted') {
    transfer.move(
      'needs_attention',
      'the partner did not take the payout; retry with the stored body and key',
      'partner_refused_or_unknown',
    );
    return;
  }
  throw e;
}

/** An unsigned transaction like the partner's, except that it pays a random account. */
async function xdrPayingAnotherAccount(ctx: LegContext, quote: LegQuote): Promise<string> {
  const { ledger, networkPassphrase } = ctx.world;
  const source = await ledger.account(ctx.account.address);
  return buildPaymentXdr({
    source: ctx.account.address,
    sequence: source?.sequence ?? '0',
    destination: Keypair.random().publicKey(),
    amount: quote.source,
    maxTime: Math.floor(Date.parse(quote.expiresAt) / 1000),
    memo: quote.id,
    networkPassphrase,
  });
}

/** Runs `sign`, which must be refused, and prints why. */
async function expectRefusal(log: (line: string) => void, what: string, sign: () => Promise<unknown>): Promise<void> {
  try {
    await sign();
  } catch (e) {
    if (e instanceof SigningNotAllowedError) {
      log(`    signer refused (${what}): ${e.message}`);
      return;
    }
    throw e;
  }
  throw new Error(`The signer should have refused: ${what}`);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Prints what `submitSignedTransaction` reports, without hashes or payloads. */
function printingLogger(log: (line: string) => void): Logger {
  const print = (msg: string, fields?: LogFields) => {
    const extra = fields?.['kind'] ?? fields?.['status'];
    log(`    grid-stellar: ${msg}${extra === undefined ? '' : ` (${String(extra)})`}`);
  };
  return { debug: () => undefined, info: print, warn: print, error: print };
}
