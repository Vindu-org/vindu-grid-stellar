// Run by each package's prepack script, from the package directory, before
// it builds. `yarn pack` runs prepack, and so does a git-tag install, which
// clones the repository and packs the workspace.
//
// - Removes dist/, so a tarball never carries output from deleted sources.
// - Copies the repository LICENSE next to package.json, so every tarball
//   carries it. The copies are gitignored: the root LICENSE is the only
//   tracked one, and a copy can never drift from it.
const fs = require('node:fs');
const path = require('node:path');

const packageDir = process.cwd();
if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
  throw new Error(`prepack-package.cjs must run from a package directory, not ${packageDir}`);
}
fs.rmSync(path.join(packageDir, 'dist'), { recursive: true, force: true });
fs.copyFileSync(path.join(__dirname, '..', 'LICENSE'), path.join(packageDir, 'LICENSE'));
