/**
 * `yarn workspace live-blindpay start`: runs the packages against your own
 * BlindPay development instance and the public Stellar testnet, and prints
 * one PASS, FAIL or FINDING line per check. Exits 0 only when nothing failed.
 *
 * It reads `BLINDPAY_API_KEY` and `BLINDPAY_INSTANCE_ID` (see `env.ts`) and
 * prints nothing from the instance unredacted. Never run it in CI.
 */
import { EnvError, type LiveEnv, readLiveEnv } from './env';
import { createRedactor } from './redact';
import { createReporter } from './report';
import { guardInstance, setUpAccount } from './step-setup';
import { settlePayins, startPayins } from './step-payin';
import { describeError, runPayouts } from './step-payout';
import { createWorld } from './world';

async function main(): Promise<number> {
  let env: LiveEnv;
  try {
    // The example's one environment read; the packages only ever get arguments.
    // eslint-disable-next-line no-restricted-properties
    env = readLiveEnv(process.env);
  } catch (e) {
    console.error(e instanceof EnvError ? e.message : 'Could not read the environment');
    return 2;
  }
  const redact = createRedactor([env.apiKey, env.instanceId]);
  const print = (line: string) => console.log(redact(line));
  const report = createReporter(redact, print);
  const world = createWorld({ env, report, redact, fetch: globalThis.fetch, print });
  const started = Date.now();

  try {
    if (!(await guardInstance(world))) return 1;
    if (!(await setUpAccount(world))) return report.exitCode() || 1;
    const payins = await startPayins(world);
    // Payouts run while the payins process.
    await runPayouts(world);
    await settlePayins(world, payins);
    report.finding('5 webhooks', 'Live webhook delivery skipped: this run has no public URL. Verification is covered offline in grid-blindpay tests');
  } catch (e) {
    report.fail('run', `Stopped with ${describeError(e)}`);
  }

  const s = report.summary();
  print(`\n${s.PASS} PASS, ${s.FAIL} FAIL, ${s.FINDING} FINDING; ${world.requests()} BlindPay requests in ${Math.round((Date.now() - started) / 1000)} s`);
  return report.exitCode();
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    // Never print the raw error: it could quote a request.
    console.error(`live-blindpay crashed: ${e instanceof Error ? e.name : typeof e}`);
    process.exitCode = 1;
  },
);
