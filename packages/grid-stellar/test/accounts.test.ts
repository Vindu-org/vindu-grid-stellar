import { stellarAsset } from '@vindu/grid-core';
import {
  ACCOUNT_MINIMUM_BALANCE_XLM,
  TRUSTLINE_RESERVE_XLM,
  assessReceiveReadiness,
  checkReceiveReadiness,
  minimumBalance,
} from '../src/accounts';
import type { HorizonAccount, HorizonBalanceLine } from '../src/horizon';
import { ACCOUNT, FakeGateway, THIRD, USDC_ISSUER } from './fake-gateway';

const USDC = stellarAsset('USDC', USDC_ISSUER);

function native(balance: string, selling = '0.0000000'): HorizonBalanceLine {
  return { asset_type: 'native', balance, selling_liabilities: selling, buying_liabilities: '0.0000000' };
}

function usdcLine(overrides: Partial<HorizonBalanceLine> = {}): HorizonBalanceLine {
  return {
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: USDC_ISSUER,
    balance: '0.0000000',
    limit: '922337203685.4775807',
    buying_liabilities: '0.0000000',
    selling_liabilities: '0.0000000',
    is_authorized: true,
    ...overrides,
  };
}

function account(balances: HorizonBalanceLine[], subentries = balances.length - 1): HorizonAccount {
  return { id: ACCOUNT, sequence: '1', subentry_count: subentries, balances };
}

describe('accounts', () => {
  it('exposes the reserve numbers: 1 XLM base plus 0.5 per trustline', () => {
    expect(ACCOUNT_MINIMUM_BALANCE_XLM).toBe('1');
    expect(TRUSTLINE_RESERVE_XLM).toBe('0.5');
    expect(minimumBalance({ subentryCount: 0 }).amount).toBe('1');
    expect(minimumBalance({ subentryCount: 1 })).toEqual({ amount: '1.5', asset: { code: 'XLM' } });
    expect(minimumBalance({ subentryCount: 1, numSponsoring: 2, numSponsored: 1 }).amount).toBe('2');
    expect(minimumBalance({ subentryCount: 1 }, '1').amount).toBe('3');
    expect(() => minimumBalance({ subentryCount: -5 })).toThrow(RangeError);
  });

  it('is ready with the account, an authorised trustline and enough XLM', () => {
    const result = assessReceiveReadiness(account([native('1.6'), usdcLine()]), USDC, { checkReserve: true, amount: '100' });
    expect(result).toEqual({
      ready: true,
      issues: [],
      exists: true,
      trustline: { balance: '0', limit: '922337203685.4775807', authorized: true },
      reserve: { required: '1.5', available: '1.6', shortfall: '0' },
    });
  });

  it('reports a missing account', () => {
    expect(assessReceiveReadiness(null, USDC)).toEqual({ ready: false, issues: ['account_missing'], exists: false });
  });

  it('reports a missing trustline, including one from another issuer', () => {
    const other = usdcLine({ asset_issuer: THIRD });
    const result = assessReceiveReadiness(account([native('5'), other]), USDC);
    expect(result).toMatchObject({ ready: false, issues: ['no_trustline'] });
  });

  it('counts the trustline still to be added in the reserve', () => {
    const result = assessReceiveReadiness(account([native('1.2')]), USDC, { checkReserve: true });
    expect(result.issues).toEqual(['no_trustline', 'reserve_too_low']);
    expect(result.reserve).toEqual({ required: '1.5', available: '1.2', shortfall: '0.3' });
  });

  it('subtracts selling liabilities from the available XLM', () => {
    const result = assessReceiveReadiness(account([native('2', '0.6'), usdcLine()]), USDC, { checkReserve: true });
    expect(result.reserve).toEqual({ required: '1.5', available: '1.4', shortfall: '0.1' });
    expect(result.issues).toEqual(['reserve_too_low']);
  });

  it('reports an unauthorised trustline and a limit with no room', () => {
    const line = usdcLine({ is_authorized: false, balance: '90.0000000', limit: '100.0000000' });
    const result = assessReceiveReadiness(account([native('5'), line]), USDC, { amount: '10.0000001' });
    expect(result.issues).toEqual(['trustline_not_authorized', 'trustline_limit_too_low']);
    expect(assessReceiveReadiness(account([native('5'), usdcLine({ balance: '90', limit: '100' })]), USDC, { amount: '10' }).ready).toBe(true);
  });

  it('skips the reserve unless asked', () => {
    expect(assessReceiveReadiness(account([native('0.1'), usdcLine()]), USDC).ready).toBe(true);
  });

  it('needs an issued asset', () => {
    expect(() => assessReceiveReadiness(null, { code: 'USDC' })).toThrow(TypeError);
  });

  it('loads the account through the gateway', async () => {
    const gateway = new FakeGateway();
    gateway.accounts.set(ACCOUNT, account([native('2'), usdcLine()]));
    expect((await checkReceiveReadiness(gateway, ACCOUNT, USDC, { checkReserve: true })).ready).toBe(true);
    expect((await checkReceiveReadiness(gateway, THIRD, USDC)).issues).toEqual(['account_missing']);
  });
});
