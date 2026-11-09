/**
 * `yarn workspace testnet-demo start`: runs the demo and prints each step.
 *
 * Offline, with no credentials: it reads no environment variables and no
 * files, and every key is a throwaway made for this run.
 */
import { runDemo } from './demo';

async function main(argv: readonly string[]): Promise<number> {
  const unknown = argv.filter((a) => a !== '--');
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}`);
    return 2;
  }
  const result = await runDemo({ log: (line) => console.log(line) });
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
