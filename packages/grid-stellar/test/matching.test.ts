import { InvalidMoneyError, fiat, money, stellarAsset } from '@vindu/grid-core';
import { type ExpectedLeg, matchPaymentToLeg, partnerAndChainAgree } from '../src/matching';
import type { ChainPayment } from '../src/payments';
import { ACCOUNT, OTHER, THIRD, USDC_ISSUER } from './fake-gateway';

const USDC = stellarAsset('USDC', USDC_ISSUER);
const FAKE_USDC = stellarAsset('USDC', THIRD);
const HASH = 'ab'.repeat(32);

function payment(overrides: Partial<ChainPayment> = {}): ChainPayment {
  return {
    id: 'op-1',
    pagingToken: 'pt-1',
    txHash: HASH,
    type: 'payment',
    direction: 'incoming',
    from: OTHER,
    to: ACCOUNT,
    asset: USDC,
    amount: '100.5',
    createdAt: '2026-11-09T12:00:00Z',
    ...overrides,
  };
}

function leg(overrides: Partial<ExpectedLeg> = {}): ExpectedLeg {
  return { legId: 'leg-1', destination: ACCOUNT, amount: money('100.5000000', USDC), ...overrides };
}

describe('matching payments to legs', () => {
  it('matches on destination, asset with issuer and exact amount', () => {
    const result = matchPaymentToLeg(payment(), [leg()]);
    expect(result).toEqual({ status: 'matched', leg: leg(), matchedOn: ['destination', 'asset', 'amount'] });
  });

  it('also requires the hash, reference and source when the leg has them', () => {
    const ok = matchPaymentToLeg(payment({ memo: 'ref-9' }), [leg({ txHash: HASH.toUpperCase(), reference: 'ref-9', source: OTHER })]);
    expect(ok).toMatchObject({ status: 'matched', matchedOn: ['destination', 'source', 'asset', 'amount', 'tx_hash', 'reference'] });

    const bad = matchPaymentToLeg(payment({ memo: 'other' }), [leg({ legId: 'L', txHash: 'cd'.repeat(32), reference: 'ref-9', source: THIRD })]);
    expect(bad).toEqual({ status: 'unmatched', mismatches: [{ legId: 'L', failed: ['source', 'tx_hash', 'reference'] }] });
  });

  it('a leg without source accepts a payment from any sender', () => {
    // Review probe: a third party paying the right amount matches a funding leg with no source.
    expect(matchPaymentToLeg(payment({ from: THIRD }), [leg()]).status).toBe('matched');
  });

  it('requireSource refuses legs without a source', () => {
    const result = matchPaymentToLeg(payment({ from: THIRD }), [leg()], { requireSource: true });
    expect(result).toEqual({ status: 'unmatched', mismatches: [{ legId: 'leg-1', failed: ['source'] }] });
    expect(matchPaymentToLeg(payment(), [leg({ source: OTHER })], { requireSource: true })).toMatchObject({
      status: 'matched',
      matchedOn: ['destination', 'source', 'asset', 'amount'],
    });
    expect(matchPaymentToLeg(payment({ from: THIRD }), [leg({ source: OTHER })], { requireSource: true }).status).toBe(
      'unmatched',
    );
  });

  it('accepts the muxed destination id as the reference', () => {
    expect(matchPaymentToLeg(payment({ toMuxedId: '42' }), [leg({ reference: '42' })]).status).toBe('matched');
  });

  it('rejects a different issuer, amount or destination with reasons', () => {
    const result = matchPaymentToLeg(payment({ asset: FAKE_USDC, to: THIRD }), [leg(), leg({ legId: 'leg-2', amount: money('100.5000001', USDC) })]);
    expect(result).toEqual({
      status: 'unmatched',
      mismatches: [
        { legId: 'leg-1', failed: ['destination', 'asset', 'amount'] },
        { legId: 'leg-2', failed: ['destination', 'asset', 'amount'] },
      ],
    });
    const amountOnly = matchPaymentToLeg(payment(), [leg({ amount: money('100.4999999', USDC) })]);
    expect(amountOnly).toEqual({ status: 'unmatched', mismatches: [{ legId: 'leg-1', failed: ['amount'] }] });
  });

  it('is ambiguous when two legs fit equally', () => {
    const result = matchPaymentToLeg(payment(), [leg(), leg({ legId: 'leg-2' })]);
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'several_legs_fit' });
    if (result.status === 'ambiguous') expect(result.candidates.map((c) => c.legId)).toEqual(['leg-1', 'leg-2']);
  });

  it('prefers the only leg that also matched a hash or reference', () => {
    const result = matchPaymentToLeg(payment(), [leg(), leg({ legId: 'leg-2', txHash: HASH })]);
    expect(result).toMatchObject({ status: 'matched', leg: { legId: 'leg-2' } });
  });

  it('is unmatched with no legs', () => {
    expect(matchPaymentToLeg(payment(), [])).toEqual({ status: 'unmatched', mismatches: [] });
  });
});

describe('matching partner and chain amounts', () => {
  it('agrees when equal or within the limit, including on the boundary', () => {
    expect(partnerAndChainAgree(money('100', USDC), money('100', USDC), 0)).toEqual({ agree: true, differenceBps: 0 });
    expect(partnerAndChainAgree(money('100', USDC), money('99.9', USDC), 10)).toEqual({ agree: true, differenceBps: 10 });
  });

  it('needs attention beyond the limit', () => {
    expect(partnerAndChainAgree(money('100', USDC), money('99.8999999', USDC), 10)).toMatchObject({
      agree: false,
      reason: 'beyond_limit',
      nextState: 'needs_attention',
    });
    expect(partnerAndChainAgree(money('100', USDC), money('100.0000001', USDC), 0).agree).toBe(false);
  });

  it('never agrees across assets or issuers', () => {
    expect(partnerAndChainAgree(money('100', USDC), money('100', FAKE_USDC), 10_000)).toEqual({
      agree: false,
      reason: 'asset_mismatch',
      nextState: 'needs_attention',
    });
    expect(partnerAndChainAgree(money('100', fiat('USDC')), money('100', USDC), 10).agree).toBe(false);
  });

  it('rejects a non-positive partner amount and a bad limit', () => {
    expect(() => partnerAndChainAgree(money('0', USDC), money('1', USDC), 10)).toThrow(InvalidMoneyError);
    expect(() => partnerAndChainAgree(money('1', USDC), money('1', USDC), -1)).toThrow(RangeError);
    expect(() => partnerAndChainAgree(money('1', USDC), money('1', USDC), 1.5)).toThrow(RangeError);
  });
});
