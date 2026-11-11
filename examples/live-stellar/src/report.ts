/**
 * Output of the run: one line per step, PASS or FAIL per scenario. Lines
 * carry statuses, hashes and shortened public addresses, never a secret key
 * or a signed envelope.
 */
import type { LogFields, Logger } from '@vindu/grid-core';

export interface Report {
  /** Something the scenario did or saw. */
  step(line: string): void;
}

export interface ScenarioOutcome {
  readonly id: string;
  readonly title: string;
  readonly passed: boolean;
  readonly error?: string;
  readonly seconds: number;
}

export type Print = (line: string) => void;

export function report(print: Print, indent = '  '): Report {
  return { step: (line) => print(`${indent}- ${line}`) };
}

/** Runs one scenario and prints its PASS or FAIL line. Never throws. */
export async function runScenario(
  id: string,
  title: string,
  print: Print,
  scenario: (report: Report) => Promise<void>,
): Promise<ScenarioOutcome> {
  print(`\n[${id}] ${title}`);
  const started = Date.now();
  try {
    await scenario(report(print));
    const seconds = Math.round((Date.now() - started) / 1000);
    print(`PASS [${id}] ${title} (${seconds}s)`);
    return { id, title, passed: true, seconds };
  } catch (e) {
    const seconds = Math.round((Date.now() - started) / 1000);
    const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    print(`FAIL [${id}] ${title} (${seconds}s): ${error}`);
    return { id, title, passed: false, error, seconds };
  }
}

/**
 * A logger for the packages that prints warnings and errors. The packages
 * log hashes, statuses and reasons only, so the lines are safe to show.
 */
export function packageLogger(print: Print): Logger {
  const line = (level: string, msg: string, fields?: LogFields) =>
    print(`    [grid-stellar ${level}] ${msg}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}`);
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg, fields) => line('warn', msg, fields),
    error: (msg, fields) => line('error', msg, fields),
  };
}
