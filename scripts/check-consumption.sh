#!/usr/bin/env bash
# Checks that the packages work for someone who installs them, not only
# inside this repository.
#
# 1. Packs each package with `yarn workspace <pkg> pack`, which runs its
#    prepack (build), as a git-tag install does, and checks each tarball
#    holds dist/, package.json, README.md and LICENSE and nothing else.
# 2. Creates a project outside the repository (nodeLinker: node-modules)
#    that installs the three tarballs, with `resolutions` pinning
#    @vindu/grid-core to the core tarball, as the README asks of consumers.
#    Install scripts are off (enableScripts: false): no dependency's
#    postinstall runs, and the packages must work without one.
# 3. Requires each package from that project, checks that internals cannot
#    be deep-imported and that there is a single copy of grid-core.
# 4. Type-checks a small file importing each package's main types, with
#    moduleResolution node (node10) and then node16, skipLibCheck on.
#
# Run `yarn install` first. Needs network access for the packages' own
# dependencies (the Stellar SDK) and for TypeScript in the temp project.
# CONSUMER_TYPESCRIPT overrides the TypeScript version used there (default:
# the one this repository uses).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/grid-consumption.XXXXXX")"
trap 'rm -rf "$work"' EXIT
packages=(grid-core grid-blindpay grid-stellar)

fail() {
  echo "check-consumption: $*" >&2
  exit 1
}

cd "$root"
typescript="${CONSUMER_TYPESCRIPT:-$(node -p "require('typescript/package.json').version")}"
package_manager="$(node -p "require('./package.json').packageManager")"

echo "== Pack"
for pkg in "${packages[@]}"; do
  log="$work/pack-$pkg.log"
  yarn workspace "@vindu/$pkg" pack --out "$work/$pkg.tgz" >"$log" 2>&1 || { cat "$log"; fail "packing @vindu/$pkg failed"; }
  files="$(tar -tzf "$work/$pkg.tgz" | sed 's|^package/||' | sort)"
  echo "@vindu/$pkg: $(grep -c . <<<"$files") files ($(grep -c '\.map$' <<<"$files" || true) source maps)"
  grep -v '\.map$' <<<"$files" | sed 's/^/  /'
  for required in package.json README.md LICENSE dist/index.js dist/index.d.ts; do
    grep -qx "$required" <<<"$files" || fail "@vindu/$pkg: $required is missing from the tarball"
  done
  unexpected="$(grep -Ev '^(package\.json|README\.md|LICENSE|dist/.+)$' <<<"$files" || true)"
  [ -z "$unexpected" ] || fail "@vindu/$pkg: unexpected files in the tarball: $unexpected"
  tar -xzOf "$work/$pkg.tgz" package/LICENSE | cmp -s - LICENSE || fail "@vindu/$pkg: LICENSE differs from the root LICENSE"
  if tar -xzOf "$work/$pkg.tgz" package/package.json | grep -q '"workspace:'; then
    fail "@vindu/$pkg: the packed package.json still has a workspace: range"
  fi
done

echo "== Install into a clean project"
consumer="$work/consumer"
mkdir -p "$consumer/src"
cat >"$consumer/package.json" <<EOF
{
  "name": "grid-consumer-check",
  "private": true,
  "packageManager": "$package_manager",
  "dependencies": {
    "@vindu/grid-blindpay": "file:$work/grid-blindpay.tgz",
    "@vindu/grid-core": "file:$work/grid-core.tgz",
    "@vindu/grid-stellar": "file:$work/grid-stellar.tgz"
  },
  "devDependencies": {
    "@types/node": "^22",
    "typescript": "$typescript"
  },
  "resolutions": {
    "@vindu/grid-core": "file:$work/grid-core.tgz"
  }
}
EOF
printf 'nodeLinker: node-modules\nenableTelemetry: false\nenableScripts: false\n' >"$consumer/.yarnrc.yml"
# An empty lockfile makes this directory its own project, whatever is above it.
: >"$consumer/yarn.lock"
(cd "$consumer" && YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install >"$work/install.log" 2>&1) || {
  cat "$work/install.log"
  fail "installing the tarballs failed"
}
[ "$(cd "$consumer" && yarn config get enableScripts)" = false ] || fail "the consumer project runs install scripts"
echo "installed with yarn $(cd "$consumer" && yarn --version), TypeScript $typescript, install scripts off"

echo "== require()"
(cd "$consumer" && node - <<'EOF'
const path = require('node:path');
const names = ['@vindu/grid-core', '@vindu/grid-blindpay', '@vindu/grid-stellar'];
for (const name of names) {
  console.log(`${name}: ${Object.keys(require(name)).length} exports`);
}
for (const deep of ['@vindu/grid-stellar/dist/sdk', '@vindu/grid-core/dist/errors', '@vindu/grid-blindpay/dist/http']) {
  try {
    require(deep);
  } catch (e) {
    if (e.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw e;
    console.log(`${deep}: not exported`);
    continue;
  }
  throw new Error(`${deep} can be deep-imported`);
}
const core = require.resolve('@vindu/grid-core');
for (const name of names.slice(1)) {
  const seen = require.resolve('@vindu/grid-core', { paths: [path.dirname(require.resolve(name))] });
  if (seen !== core) throw new Error(`${name} loads its own copy of grid-core: ${seen}`);
}
const { InvalidConfigError } = require('@vindu/grid-core');
const { createBlindPayAdapter } = require('@vindu/grid-blindpay');
try {
  createBlindPayAdapter({ apiKey: 'placeholder', instanceId: 'in_check' }, { network: 'not-a-network' });
  throw new Error('createBlindPayAdapter accepted an unknown network');
} catch (e) {
  if (!(e instanceof InvalidConfigError)) throw e;
}
console.log('one copy of @vindu/grid-core: its errors are instanceof across packages');
EOF
)

echo "== tsc --noEmit"
cat >"$consumer/src/check.ts" <<'EOF'
import {
  type LegQuote,
  type PartnerAdapter,
  type Signer,
  type StellarSubmitter,
  type SubmitOutcome,
  type TransferState,
  InvalidConfigError,
  canSignReplacement,
  money,
  runSignedPayout,
  selectRoute,
  stellarAsset,
  transition,
} from '@vindu/grid-core';
import {
  type BlindPayAdapter,
  type RunStellarPayoutInput,
  createBlindPayAdapter,
  runStellarPayout,
  verifyWebhook,
} from '@vindu/grid-blindpay';
import {
  type HorizonGateway,
  type SubmitResult,
  STELLAR_TESTNET,
  createHorizonGateway,
  createReadLayer,
  createStellarSubmitter,
  submitSignedTransaction,
} from '@vindu/grid-stellar';

// The packages fit together through core's ports.
export const submitterFor = (gateway: HorizonGateway): StellarSubmitter =>
  createStellarSubmitter({ gateway, networkPassphrase: STELLAR_TESTNET.networkPassphrase });
export const asPartner = (adapter: BlindPayAdapter): PartnerAdapter => adapter;
export const replaceable = (outcome: SubmitOutcome): boolean => canSignReplacement(outcome);
export const state: TransferState = transition('quoted', 'awaiting_pix').to;
export type Pieces = [LegQuote, Signer, RunStellarPayoutInput, SubmitResult, InvalidConfigError];
export const used = [
  createBlindPayAdapter,
  runStellarPayout,
  verifyWebhook,
  createHorizonGateway,
  createReadLayer,
  submitSignedTransaction,
  runSignedPayout,
  selectRoute,
  money('1', stellarAsset('USDC', STELLAR_TESTNET.networkPassphrase)),
];

// The types are real, not `any`: each line below must be a type error.
// @ts-expect-error an amount is a decimal string
money(1, stellarAsset('USDC', 'G'));
// @ts-expect-error 'paid' is not a transfer state
export const wrong: TransferState = 'paid';
// @ts-expect-error a submitter must return a SubmitOutcome, not a bare hash
export const notASubmitter: StellarSubmitter = { maxDurationMs: 0, submit: async () => ({ hash: 'x' }) };
// @ts-expect-error a submitter must say how long one submit can take
export const noBudget: StellarSubmitter = { submit: async () => ({ status: 'success', hash: 'x' }) };
EOF
for resolution in node node16; do
  module=commonjs
  [ "$resolution" = node16 ] && module=node16
  cat >"$consumer/tsconfig.$resolution.json" <<EOF
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "$module",
    "moduleResolution": "$resolution",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "files": ["src/check.ts"]
}
EOF
  (cd "$consumer" && node node_modules/typescript/bin/tsc -p "tsconfig.$resolution.json")
  echo "moduleResolution $resolution: ok"
done

echo "check-consumption: ok"
