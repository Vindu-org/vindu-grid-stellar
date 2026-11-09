import { type HorizonServer, createHorizonGateway } from '../src/horizon';
import { TESTNET_HORIZON_URL, TESTNET_NETWORK_PASSPHRASE } from '../src/networks';
import { stellarSdk } from '../src/sdk';

const { Account, Horizon, Keypair, Networks, NotFoundError, Operation, TransactionBuilder } = stellarSdk;

function signedXdr(): string {
  const source = Keypair.random();
  const tx = new TransactionBuilder(new Account(source.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: '5' }))
    .setTimeout(60)
    .build();
  tx.sign(source);
  return tx.toXDR();
}

/** A stand-in for Horizon.Server with only the calls the gateway makes. No network. */
function fakeServer(overrides: {
  submit?: () => Promise<unknown>;
  tx?: () => Promise<unknown>;
  page?: unknown[];
  ledgers?: unknown[];
}) {
  const cursor = jest.fn();
  const chain: Record<string, unknown> = {
    call: async () => ({ records: overrides.page ?? [] }),
  };
  for (const step of ['forAccount', 'order', 'limit', 'join']) chain[step] = () => chain;
  chain['cursor'] = (c: string) => {
    cursor(c);
    return chain;
  };
  const ledgerQuery: Array<[string, unknown]> = [];
  const ledgers: Record<string, unknown> = { call: async () => ({ records: overrides.ledgers ?? [] }) };
  for (const step of ['order', 'limit', 'cursor']) {
    ledgers[step] = (v: unknown) => {
      ledgerQuery.push([step, v]);
      return ledgers;
    };
  }
  const server = {
    payments: () => chain,
    ledgers: () => ledgers,
    transactions: () => ({ transaction: () => ({ call: overrides.tx ?? (async () => ({})) }) }),
    submitTransaction: overrides.submit ?? (async () => ({})),
    accounts: () => ({ accountId: () => ({ call: async () => Promise.reject(new NotFoundError('nf', { status: 404 })) }) }),
  };
  return { server: server as unknown as HorizonServer, cursor, ledgerQuery };
}

function gatewayWith(overrides: Parameters<typeof fakeServer>[0]) {
  const { server, cursor, ledgerQuery } = fakeServer(overrides);
  return {
    gateway: createHorizonGateway({ horizonUrl: TESTNET_HORIZON_URL, networkPassphrase: TESTNET_NETWORK_PASSPHRASE, server }),
    cursor,
    ledgerQuery,
  };
}

const httpError = (status: number, data?: unknown) => Object.assign(new Error('http'), { response: { status, data } });

describe('horizon gateway', () => {
  it("accepts the SDK's Horizon.Server as a HorizonServer", () => {
    // Compile-time check: the structural type fits the SDK's server.
    const server: HorizonServer = new Horizon.Server(TESTNET_HORIZON_URL);
    expect(typeof server.payments).toBe('function');
  });

  it('exposes its network passphrase', () => {
    expect(gatewayWith({}).gateway.networkPassphrase).toBe(TESTNET_NETWORK_PASSPHRASE);
  });

  it('reads the latest ingested ledger, newest first', async () => {
    const { gateway, ledgerQuery } = gatewayWith({
      ledgers: [{ sequence: 51, closed_at: '2026-11-09T12:00:05Z', _links: {} }],
    });
    expect(await gateway.latestLedger()).toEqual({ sequence: 51, closedAt: new Date('2026-11-09T12:00:05Z') });
    expect(ledgerQuery).toEqual([
      ['order', 'desc'],
      ['limit', 1],
    ]);
  });

  it('fails latestLedger when Horizon returns no usable ledger', async () => {
    for (const ledgers of [[], [{ sequence: 51 }], [{ sequence: '51', closed_at: '2026-11-09T12:00:05Z' }], [{ sequence: 51, closed_at: 'soon' }]]) {
      await expect(gatewayWith({ ledgers }).gateway.latestLedger()).rejects.toThrow('no usable latest ledger');
    }
  });

  it('treats a submit answer without a hash or result as unavailable', async () => {
    const { gateway } = gatewayWith({ submit: async () => ({ ledger: 4 }) });
    expect(await gateway.submitTransaction(signedXdr())).toEqual({ kind: 'unavailable', status: null });
  });

  it('fails a lookup whose answer has no hash or result', async () => {
    const { gateway } = gatewayWith({ tx: async () => ({ ledger_attr: 3 }) });
    await expect(gateway.transaction('ab')).rejects.toThrow('without a hash');
  });

  it('maps a 400 with result codes to a rejection with codes only', async () => {
    const { gateway } = gatewayWith({
      submit: async () => {
        throw httpError(400, { extras: { result_codes: { transaction: 'tx_bad_seq' }, envelope_xdr: 'AAAA' } });
      },
    });
    expect(await gateway.submitTransaction(signedXdr())).toEqual({
      kind: 'rejected',
      status: 400,
      transactionCode: 'tx_bad_seq',
      operationCodes: [],
    });
  });

  it('maps a 504 to a timeout, a missing response to unavailable and 429 to unavailable', async () => {
    const cases: Array<[unknown, unknown]> = [
      [httpError(504), { kind: 'timeout', status: 504 }],
      [new Error('socket hang up'), { kind: 'unavailable', status: null }],
      [httpError(429), { kind: 'unavailable', status: 429 }],
      [Object.assign(new Error('t'), { code: 'ECONNABORTED' }), { kind: 'timeout' }],
    ];
    for (const [thrown, expected] of cases) {
      const { gateway } = gatewayWith({ submit: async () => Promise.reject(thrown) });
      expect(await gateway.submitTransaction(signedXdr())).toEqual(expected);
    }
  });

  it('returns accepted submissions', async () => {
    const { gateway } = gatewayWith({ submit: async () => ({ hash: 'h', ledger: 4, successful: true }) });
    expect(await gateway.submitTransaction(signedXdr())).toEqual({ kind: 'accepted', hash: 'h', ledger: 4, successful: true });
  });

  it('treats a missing transaction or account as not found', async () => {
    const { gateway } = gatewayWith({ tx: async () => Promise.reject(new NotFoundError('nf', { status: 404 })) });
    expect(await gateway.transaction('ab')).toEqual({ found: false });
    expect(await gateway.account(Keypair.random().publicKey())).toBeNull();
  });

  it('rethrows other lookup errors', async () => {
    const { gateway } = gatewayWith({ tx: async () => Promise.reject(httpError(500)) });
    await expect(gateway.transaction('ab')).rejects.toThrow('http');
  });

  it('keeps known payment fields and the joined memo only', async () => {
    const { gateway, cursor } = gatewayWith({
      page: [{ id: '1', paging_token: 'p1', type: 'payment', amount: '1.0000000', _links: {}, transaction_attr: { memo: 'm', memo_type: 'text', envelope_xdr: 'x' } }],
    });
    const records = await gateway.paymentsForAccount('G', { cursor: 'p0', limit: 10, order: 'asc' });
    expect(records).toEqual([{ id: '1', paging_token: 'p1', type: 'payment', amount: '1.0000000', memo: 'm', memo_type: 'text' }]);
    expect(cursor).toHaveBeenCalledWith('p0');
  });
});
