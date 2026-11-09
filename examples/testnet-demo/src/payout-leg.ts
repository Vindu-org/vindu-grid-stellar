/**
 * Leg two: USDC from the client's Stellar account to USD by wire, through
 * the supported signed payout path: core's `runSignedPayout` with
 * grid-stellar's `createStellarSubmitter`.
 *
 * funded -> payout_quoted -> awaiting_signature -> payout_submitted
 *   -> payout_processing -> completed
 *
 * The fresh payout quote must be within the price tolerance of the estimate
 * the client saw. The partner returns an unsigned transaction; the signer
 * checks it before signing, once; the signed transaction is submitted with
 * the hash checked before any retry; only a confirmed success lets the
 * partner payout be created.
 *
 * Where the flow can stop, the transfer takes the failure edge from core's
 * table, and nothing is re-signed, refunded or rerouted automatically:
 * - the payout quote fails: `funded -> needs_attention` (payout_quote_failed);
 * - the quote is outside tolerance: `funded -> needs_attention` (quote_outside_tolerance);
 * - the quote gets too close to expiry before the transaction leaves:
 *   `awaiting_signature -> funded`, nothing was submitted;
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
  PayoutIncompleteError,
  QuoteExpiredError,
  type SignedPayoutContext,
  type SignedPayoutResult,
  SigningNotAllowedError,
  type StellarSubmitter,
  type TransferState,
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

  // What runSignedPayout and the signer compare the transaction with.
  const payoutContext = (state: TransferState): SignedPayoutContext => ({
    transferId: transfer.id,
    state,
    quote,
    account: ctx.account,
    destination: partner.treasuryAddress,
  });
  const submitterOptions = {
    gateway: ledger,
    networkPassphrase,
    now: ctx.now,
    sleep: async () => undefined,
    logger: printingLogger(log),
  };

  // 2. The signer checks what it signs. Two refusals first; nothing is signed.
  const stranger = await xdrPayingAnotherAccount(ctx, quote);
  await expectRefusal(log, 'asked to sign before awaiting_signature', () =>
    signer.signStellar(ctx.account, stranger, signingContextFor(payoutContext(transfer.state))),
  );
  transfer.move('awaiting_signature', `${partner.id} pays out from the client's own account, so the client's key holder signs`);

  // A partner whose unsigned transaction pays someone else, through the same flow.
  await expectRefusal(log, 'XDR that pays another account', () =>
    runSignedPayout({
      adapter: {
        preparePayout: async () => ({ kind: 'stellar_xdr', unsignedXdr: stranger }),
        executePayout: async () => {
          throw new Error('Never reached: the signer refuses first');
        },
      },
      signer,
      submitter: createStellarSubmitter(submitterOptions),
      submission: 'client_submits',
      context: payoutContext(transfer.state),
      now: ctx.now,
      idempotencyKey: `${transfer.id}:payout-refused`,
    }),
  );

  // 3. The real run: prepare, sign once, submit, then the partner payout.
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
  // The application records the outcome as it happens: after a success the
  // transfer is payout_submitted before the partner hears about it.
  const submitter: StellarSubmitter = {
    async submit(signedXdr) {
      const outcome = await stellar.submit(signedXdr);
      log(
        `    submit: ${outcome.status}, tx ${short(outcome.hash)}; ` +
          `${ledger.submissions.length - before.submissions} submission(s), ` +
          `${ledger.lookups.length - before.lookups} hash lookup(s), no second signature`,
      );
      if (outcome.status === 'success') {
        transfer.move('payout_submitted', `tx ${short(outcome.hash)} in ledger ${outcome.detail.ledger ?? '?'}`);
      }
      return outcome;
    },
  };

  let result: SignedPayoutResult;
  try {
    result = await runSignedPayout({
      adapter: partner,
      signer,
      submitter,
      submission: 'client_submits',
      context: payoutContext(transfer.state),
      now: ctx.now,
      idempotencyKey: `${transfer.id}:payout`,
      onSigned: () =>
        log(
          `    signer (${signer.custody}) checked state, expiry, source and operation source, destination, ` +
            'asset, amount, fee and maxTime, then signed once; the signed XDR is stored before it leaves',
        ),
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
  if (e instanceof QuoteExpiredError && transfer.state === 'awaiting_signature') {
    transfer.move('funded', `${e.message}; nothing was submitted, get a fresh quote`);
    return;
  }
  if (e instanceof PayoutIncompleteError && e.stage === 'submit' && transfer.state === 'awaiting_signature') {
    const tx = e.txHash === undefined ? '' : ` tx ${short(e.txHash)}`;
    transfer.move(
      'needs_attention',
      `submit ended ${e.outcome?.status ?? 'without an outcome'}; check${tx} on Stellar, do not sign again`,
    );
    return;
  }
  if (e instanceof PayoutIncompleteError && e.stage === 'create' && transfer.state === 'payout_submitted') {
    transfer.move('needs_attention', 'the partner did not take the payout; retry with the stored body and key');
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
