import { type Logger, type PartnerCall, noopLogger, reportPartnerCall } from '../src/observability';

const call: PartnerCall = { partner: 'p', method: 'POST', path: '/v1/x', status: 200, durationMs: 12 };

describe('observability', () => {
  it('noopLogger accepts every level', () => {
    expect(() => {
      noopLogger.debug('a');
      noopLogger.info('b', { k: 1 });
      noopLogger.warn('c');
      noopLogger.error('d');
    }).not.toThrow();
  });

  it('passes the call to the hook', () => {
    const onCall = jest.fn();
    reportPartnerCall(onCall, call);
    expect(onCall).toHaveBeenCalledWith(call);
  });

  it('a throwing hook never breaks the caller and is logged without payload', () => {
    const warn = jest.fn();
    const logger: Logger = { ...noopLogger, warn };
    expect(() =>
      reportPartnerCall(
        () => {
          throw new Error('secret-in-message');
        },
        call,
        logger,
      ),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith('onCall hook threw', { partner: 'p', method: 'POST', error: 'Error' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-in-message');
  });

  it('does nothing without a hook', () => {
    expect(() => reportPartnerCall(undefined, call)).not.toThrow();
  });
});
