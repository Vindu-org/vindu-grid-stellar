/**
 * Leg two: USDC from the client's Stellar account to USD by wire, through
 * the signed payout flow.
 *
 * funded -> payout_quoted -> awaiting_signature -> payout_submitted
 *   -> payout_processing -> completed
 *
 * The fresh payout quote must be within the price tolerance of the estimate
 * the client saw. The partner returns an unsigned transaction; the signer
 * checks it before signing; the signed transaction is submitted with the
 * hash checked before any retry; then the partner is told about it.
 */
import {
  type LogFields,
  type Logger,
  type Money,
  type SigningContext,
  SigningNotAllowedError,
  type TransferState,
  checkPayoutTolerance,
} from '@vindu/grid-core';
import { submitSignedTransaction } from '@vindu/grid-stellar';

import { describeMatch } from './chain-watch';
import { fmt, short } from './format';
import type { LegContext } from './leg-context';
import { Keypair } from './sdk';
import { buildPaymentXdr, decodePayment } from './stellar-tx';
import { USD } from './world';

/** How far the payout quote may move from the estimate, in basis points. */
export const PAYOUT_TOLERANCE_BPS = 30;

export interface PayoutOptions {
  /** Make Horizon time out once on the payout submission, to show the hash check. */
  readonly simulateHorizonTimeout: boolean;
}

/** Returns the payout transaction hash, or `undefined` when the transfer stopped in `needs_attention`. */
export async function runPayoutLeg(
  ctx: LegContext,
  funded: Money,
  estimate: Money,
  options: PayoutOptions,
): Promise<string | undefined> {
  const { world, transfer, log } = ctx;
  const { partner, signer, ledger, networkPassphrase } = world;

  // 1. A fresh payout quote, checked against the estimate the client saw.
  const quote = await partner.quotePayout({
    customerId: ctx.customerId,
    account: ctx.account,
    source: funded,
    targetAsset: USD,
    rail: 'wire',
    beneficiaryId: 'demo-beneficiary',
  });
  log(`    payout quote ${quote.id}: ${fmt(quote.source)} -> ${fmt(quote.target)}`);
  const tolerance = checkPayoutTolerance(estimate, quote.target, PAYOUT_TOLERANCE_BPS);
  const gap = `${tolerance.deviationBps} bps from the estimate ${fmt(estimate)}, tolerance ${PAYOUT_TOLERANCE_BPS} bps`;
  if (!tolerance.ok) {
    transfer.move(tolerance.nextState, `${fmt(quote.target)} is ${gap}; the USDC stays in the account`);
    return undefined;
  }
  transfer.move('payout_quoted', `${fmt(quote.target)} is ${gap}`);

  // 2. The partner returns an unsigned transaction for the client's account.
  const auth = await partner.preparePayout({ quote, account: ctx.account, transferId: transfer.id });
  if (auth.kind !== 'stellar_xdr') throw new Error(`${partner.id} should use the signed payout flow`);
  const context = (state: TransferState): SigningContext => ({
    transferId: transfer.id,
    state,
    quoteId: quote.id,
    expiresAt: quote.expiresAt,
    expected: { amount: quote.source, destination: partner.treasuryAddress },
  });

  await expectRefusal(log, 'asked to sign before awaiting_signature', () =>
    signer.signStellar(ctx.account, auth.unsignedXdr, context(transfer.state)),
  );
  transfer.move('awaiting_signature', `unsigned XDR from ${partner.id}, paying ${fmt(quote.source)} to ${short(partner.treasuryAddress)}`);

  // 3. The signer checks what it signs.
  const unsigned = decodePayment(auth.unsignedXdr, networkPassphrase);
  const sourceAccount = await ledger.account(ctx.account.address);
  const swapped = buildPaymentXdr({
    source: unsigned.source,
    sequence: sourceAccount?.sequence ?? '0',
    destination: Keypair.random().publicKey(),
    amount: unsigned.amount,
    maxTime: unsigned.maxTime ?? 0,
    networkPassphrase,
  });
  await expectRefusal(log, 'XDR that pays another account', () =>
    signer.signStellar(ctx.account, swapped, context(transfer.state)),
  );
  const signedXdr = await signer.signStellar(ctx.account, auth.unsignedXdr, context(transfer.state));
  log(`    signer (${signer.custody}) checked state, expiry, source, destination, asset and amount, then signed`);

  // 4. Submit. On a timeout the hash is checked before anything else.
  if (options.simulateHorizonTimeout) {
    ledger.timeOutNextSubmission();
    log('    (Horizon is set to time out on this submission, after the transaction lands)');
  }
  const before = { submissions: ledger.submissions.length, lookups: ledger.lookups.length };
  const result = await submitSignedTransaction({
    gateway: ledger,
    signedXdr,
    networkPassphrase,
    now: ctx.now,
    sleep: async () => undefined,
    logger: printingLogger(log),
  });
  log(
    `    submit: ${result.status}, tx ${short(result.hash)}; ` +
      `${ledger.submissions.length - before.submissions} submission(s), ` +
      `${ledger.lookups.length - before.lookups} hash lookup(s), no second signature`,
  );
  if (result.status !== 'success') throw new Error(`Unexpected submit status ${result.status}`);
  transfer.move('payout_submitted', `tx ${short(result.hash)} in ledger ${result.ledger ?? '?'}`);

  // 5. Hand the partner the signed transaction and its hash.
  const ref = await partner.executePayout({
    quote,
    account: ctx.account,
    transferId: transfer.id,
    idempotencyKey: `${transfer.id}:payout`,
    signedXdr,
    txHash: result.hash,
  });
  const accepted = await partner.readLeg(ref);
  if (accepted.status !== 'processing' && accepted.status !== 'completed') {
    transfer.move('needs_attention', `${partner.id} reports payout ${accepted.status}`);
    return undefined;
  }
  transfer.move('payout_processing', `${partner.id} accepted payout ${ref.id}`);

  // 6. The read layer resumes from its cursor and sees the outgoing payment.
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
            txHash: result.hash,
            reference: quote.id,
          },
        ]);
  log(`    ${match.text}`);
  if (!match.matched) {
    transfer.move('needs_attention', 'the payout is not on chain as signed');
    return undefined;
  }

  log('    (the beneficiary bank receives the wire)');
  partner.simulateFiatLanded(ref.id);
  const landed = await partner.readLeg(ref);
  if (landed.status !== 'completed') {
    transfer.move('needs_attention', `${partner.id} reports payout ${landed.status}`);
    return undefined;
  }
  transfer.move('completed', `${fmt(landed.amount ?? quote.target)} delivered by wire`);
  return result.hash;
}

/** Runs `sign`, which must be refused, and prints why. */
async function expectRefusal(log: (line: string) => void, what: string, sign: () => Promise<string>): Promise<void> {
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

/** Prints what `submitSignedTransaction` reports, without hashes or payloads. */
function printingLogger(log: (line: string) => void): Logger {
  const print = (msg: string, fields?: LogFields) => {
    const extra = fields?.['kind'] ?? fields?.['status'];
    log(`    grid-stellar: ${msg}${extra === undefined ? '' : ` (${String(extra)})`}`);
  };
  return { debug: () => undefined, info: print, warn: print, error: print };
}
