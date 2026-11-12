/**
 * One line per check: PASS, FAIL or FINDING, through the redactor.
 *
 * - PASS: the instance did what the library expects.
 * - FAIL: something the run needs did not happen. The run exits 1.
 * - FINDING: a fact about the real instance worth writing down (a
 *   difference from the docs, an answer to an open question). Not a failure.
 */
import type { Redactor } from './redact';

export type Verdict = 'PASS' | 'FAIL' | 'FINDING';

export interface ReportLine {
  readonly verdict: Verdict | 'INFO';
  readonly step: string;
  readonly text: string;
}

export interface Reporter {
  pass(step: string, text: string): void;
  fail(step: string, text: string): void;
  finding(step: string, text: string): void;
  info(step: string, text: string): void;
  /** True when the condition holds; a PASS line if so, else a FAIL line. */
  check(step: string, ok: boolean, text: string): boolean;
  readonly lines: readonly ReportLine[];
  /** Counts per verdict. */
  summary(): Readonly<Record<Verdict, number>>;
  /** 0 when nothing failed and something passed, else 1. */
  exitCode(): number;
}

export function createReporter(redact: Redactor, print: (line: string) => void): Reporter {
  const lines: ReportLine[] = [];
  const add = (verdict: ReportLine['verdict'], step: string, text: string) => {
    const line = { verdict, step, text: redact(text) };
    lines.push(line);
    print(redact(`${verdict.padEnd(7)} [${step}] ${line.text}`));
  };
  const count = (v: Verdict) => lines.filter((l) => l.verdict === v).length;
  return {
    pass: (step, text) => add('PASS', step, text),
    fail: (step, text) => add('FAIL', step, text),
    finding: (step, text) => add('FINDING', step, text),
    info: (step, text) => add('INFO', step, text),
    check(step, ok, text) {
      add(ok ? 'PASS' : 'FAIL', step, text);
      return ok;
    },
    lines,
    summary: () => ({ PASS: count('PASS'), FAIL: count('FAIL'), FINDING: count('FINDING') }),
    exitCode: () => (count('FAIL') === 0 && count('PASS') > 0 ? 0 : 1),
  };
}
