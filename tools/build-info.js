// Build info shown on the main menu: the version from version.json plus the
// current git commit. `node tools/build-info.js` writes buildinfo.json (which
// is gitignored) for the plain static servers; server/index.js calls
// getBuildInfo() directly and serves the same shape at /buildinfo.json.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

function getBuildInfo() {
  const info = { version: JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version };
  try {
    info.commit = git('rev-parse', '--short', 'HEAD');
    info.dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
  } catch (e) { /* not a git checkout (or no git): version only */ }
  return info;
}

module.exports = { getBuildInfo };

if (require.main === module) {
  fs.writeFileSync(path.join(ROOT, 'buildinfo.json'), JSON.stringify(getBuildInfo()) + '\n');
}
