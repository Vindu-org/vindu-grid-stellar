/**
 * `yarn workspace testnet-demo start`: runs the demo and prints each step.
 *
 * Offline, with no credentials: it reads no environment variables and no
 * files, and every key is a throwaway made for this run. Add
 * `--blindpay-dry-run` to also run the flow through the BlindPay client
 * against a mocked fetch.
 */
import { runBlindPayDryRun } from './blindpay-dry-run';
import { runDemo } from './demo';

const DRY_RUN_FLAG = '--blindpay-dry-run';

async function main(argv: readonly string[]): Promise<number> {
  const unknown = argv.filter((a) => a !== '--' && a !== DRY_RUN_FLAG);
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}. The only option is ${DRY_RUN_FLAG}.`);
    return 2;
  }
  const log = (line: string) => console.log(line);
  const result = await runDemo({ log });
  if (argv.includes(DRY_RUN_FLAG)) await runBlindPayDryRun(log);
  return result.finalState === 'completed' ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  },
);
