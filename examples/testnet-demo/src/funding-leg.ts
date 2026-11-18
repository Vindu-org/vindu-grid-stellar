/**
 * Leg one: BRL by PIX to USDC in the client's Stellar account.
 *
 * quoted -> awaiting_pix -> funding -> funded. The transfer counts as funded
 * only when the payment is on chain, matches the leg, and the partner's
 * figure and the chain agree.
 */
import { type LegQuote, type Money, money } from '@vindu/grid-core';
import { partnerAndChainAgree } from '@vindu/grid-stellar';

import { describeMatch } from './chain-watch';
import { fmt, short } from './format';
import type { LegContext } from './leg-context';

/** Returns the funded amount, or `undefined` when the transfer stopped in `needs_attention`. */
export async function runFundingLeg(ctx: LegContext, quote: LegQuote): Promise<Money | undefined> {
  const { world, transfer, log } = ctx;
  const { partner } = world;

  const instructions = await partner.createFunding({
    quote,
    customerId: ctx.customerId,
    account: ctx.account,
    transferId: transfer.id,
    idempotencyKey: `${transfer.id}:funding`,
  });
  transfer.move('awaiting_pix', `PIX code ${instructions.pixCode ?? '(none)'}`);

  log('    (the client pays the PIX)');
  partner.simulatePixPaid(instructions.leg.id);
  const paid = await partner.readLeg(instructions.leg);
  if (paid.status !== 'processing' && paid.status !== 'completed') {
    throw new Error(`Unexpected funding status ${paid.status}`);
  }
  transfer.move('funding', `${partner.id} reports payin ${paid.ref.id} ${paid.status}`);

  const settled = await partner.simulateFundingSettled(instructions.leg.id);
  log(`    ${partner.id} sends ${fmt(quote.target)} to ${short(ctx.account.address)}: submit ${settled.status}, tx ${short(settled.hash)}`);
  const leg = await partner.readLeg(instructions.leg);

  const poll = await ctx.watch.poll();
  log(`    read layer: ${poll.fresh.length} new payment(s), cursor ${poll.from ?? 'start'} -> ${poll.to ?? 'start'}`);
  const payment = poll.fresh.find((p) => p.direction === 'incoming');
  if (payment === undefined) {
    transfer.move('needs_attention', 'no incoming payment on chain');
    return undefined;
  }
  const match = describeMatch(payment, [
    { legId: `${transfer.id}/funding`, destination: ctx.account.address, amount: quote.target },
  ]);
  log(`    ${match.text}`);
  if (!match.matched || leg.status !== 'completed' || leg.amount === undefined) {
    transfer.move('needs_attention', 'partner and chain do not show the same funding');
    return undefined;
  }

  const onChain = money(payment.amount, payment.asset);
  const agreement = partnerAndChainAgree(leg.amount, onChain, 0);
  if (!agreement.agree) {
    transfer.move('needs_attention', `partner says ${fmt(leg.amount)}, chain says ${fmt(onChain)}`);
    return undefined;
  }
  transfer.move('funded', `partner says ${fmt(leg.amount)}, chain says ${fmt(onChain)}: they agree`);
  return onChain;
}
