import * as stellar from '../src';
import { stellarSdk } from '../src/sdk';

describe('index exports', () => {
  it.each([
    'createHorizonGateway',
    'createReadLayer',
    'InMemoryCursorStore',
    'matchPaymentToLeg',
    'partnerAndChainAgree',
    'submitSignedTransaction',
    'inspectSignedTransaction',
    'createStellarSubmitter',
    'DEFAULT_HORIZON_REQUEST_TIMEOUT_MS',
    'toSubmitOutcome',
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

  it.each(['stellarSdk', 'normalisePayment', 'assetFromHorizon', 'mapResultCodes', 'resultCodesFromXdr'])('keeps %s internal', (name) => {
    expect(stellar).not.toHaveProperty(name);
  });

  it('matches the SDK network passphrases', () => {
    const { Networks } = stellarSdk;
    expect(stellar.TESTNET_NETWORK_PASSPHRASE).toBe(Networks.TESTNET);
    expect(stellar.MAINNET_NETWORK_PASSPHRASE).toBe(Networks.PUBLIC);
  });
});
