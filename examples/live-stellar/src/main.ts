/**
 * `yarn workspace live-stellar start`: runs `@vindu/grid-stellar` against the
 * public Stellar testnet and prints PASS or FAIL per scenario. Exits 0 only
 * when every scenario passed.
 *
 * Online and testnet only: it refuses any other Horizon URL or passphrase.
 * It reads no environment variables and no files; every key is a throwaway
 * made with `Keypair.random()` for this run and never leaves memory. Never
 * run in CI.
 */
import { assertTestnet, networkFromArgs } from './network';
import { type ScenarioOutcome, packageLogger, report, runScenario } from './report';
import { expiryScenario } from './scenarios/expiry';
import { feeBumpScenario } from './scenarios/fee-bump';
import { payoutXdrScenario } from './scenarios/payout-xdr';
import { readLayerScenario } from './scenarios/read-layer';
import { resubmitScenario } from './scenarios/resubmit';
import { Testnet } from './testnet';
import { type World, createWorld } from './world';

const SCENARIOS: ReadonlyArray<readonly [string, string, (world: World, r: ReturnType<typeof report>) => Promise<void>]> = [
  ['1', 'read layer: each payment delivered once across a restart; matched to its leg', readLayerScenario],
  ['2', 'submit, then submit the same envelope again: recognised by hash, paid once', resubmitScenario],
  ['3', 'fee bump: found by outer and inner hash', feeBumpScenario],
  ['4', 'expiry proof: never-sent envelope expired_not_landed; landed envelope never expired', expiryScenario],
  ['5', 'assertPayoutXdrMatches: real transaction accepted, tampered ones refused', payoutXdrScenario],
];

async function main(argv: readonly string[]): Promise<number> {
  const print = (line: string) => console.log(line);
  let network;
  try {
    network = networkFromArgs(argv);
    assertTestnet(network);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  print(`live-stellar: ${network.horizonUrl} (testnet), throwaway accounts from friendbot`);

  const testnet = new Testnet(network, packageLogger(print));
  print('\n[setup] accounts, trustlines and the test asset');
  let world: World;
  try {
    world = await createWorld(testnet, report(print));
  } catch (e) {
    print(`FAIL [setup]: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return 1;
  }

  const outcomes: ScenarioOutcome[] = [];
  for (const [id, title, scenario] of SCENARIOS) {
    outcomes.push(await runScenario(id, title, print, (r) => scenario(world, r)));
  }

  const failed = outcomes.filter((o) => !o.passed);
  print(`\n${outcomes.length - failed.length}/${outcomes.length} scenarios passed`);
  for (const o of outcomes) print(`  ${o.passed ? 'PASS' : 'FAIL'} [${o.id}] ${o.title}`);
  return failed.length === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    process.exitCode = 1;
  },
);
