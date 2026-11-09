import * as stellar from '../src';
import { stellarSdk } from '../src/sdk';

describe('index exports', () => {
  it.each([
    'createHorizonGateway',
    'createReadLayer',
    'InMemoryCursorStore',
    'normalisePayment',
    'matchPaymentToLeg',
    'partnerAndChainAgree',
    'submitSignedTransaction',
    'inspectSignedTransaction',
    'mapResultCodes',
    'assessReceiveReadiness',
    'checkReceiveReadiness',
    'minimumBalance',
    'TESTNET_NETWORK_PASSPHRASE',
    'MAINNET_NETWORK_PASSPHRASE',
    'TESTNET_HORIZON_URL',
    'MAINNET_HORIZON_URL',
  ])('exports %s', (name) => {
    expect(stellar).toHaveProperty(name);
  });

  it('does not expose the raw SDK', () => {
    expect(stellar).not.toHaveProperty('stellarSdk');
  });

  it('matches the SDK network passphrases', () => {
    const { Networks } = stellarSdk;
    expect(stellar.TESTNET_NETWORK_PASSPHRASE).toBe(Networks.TESTNET);
    expect(stellar.MAINNET_NETWORK_PASSPHRASE).toBe(Networks.PUBLIC);
  });
});
