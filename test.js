// Proves the one thing this action gets wrong when two deploys finish at the same time: the push
// is rejected, and without a retry the image tag never lands.
//
// Run: node test.js   (needs git; no framework, no network)
//
// The setup is the real race, not a mock. The `script` input pushes a competing commit to the
// target branch the first time it runs, so our first push is guaranteed to be rejected.

const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ufor-test-'));
const origin = path.join(root, 'origin.git');
const seed = path.join(root, 'seed');
const rival = path.join(root, 'rival');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sh = (cmd, cwd) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });

function commitAll(repo, message) {
  git(['add', '-A'], repo);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', message], repo);
}

// --- a GitOps repo with two services' values files -------------------------------------------
git(['init', '--bare', '-b', 'main', origin], root);
git(['clone', origin, seed], root);
fs.writeFileSync(path.join(seed, 'ours.yaml'), 'imageTag: "old"\n');
fs.writeFileSync(path.join(seed, 'theirs.yaml'), 'imageTag: "untouched"\n');
commitAll(seed, 'seed');
git(['push', 'origin', 'main'], seed);

// --- the rival deploy: pushes once, the first time our script runs ----------------------------
git(['clone', origin, rival], root);
const flag = path.join(root, 'rival-pushed');
const script = `
set -e
sed -i.bak 's/^imageTag: .*$/imageTag: "new"/' ours.yaml && rm -f ours.yaml.bak
if [ ! -f ${flag} ]; then
  touch ${flag}
  cd ${rival}
  sed -i.bak 's/^imageTag: .*$/imageTag: "rival"/' theirs.yaml && rm -f theirs.yaml.bak
  git add -A
  git -c user.name=r -c user.email=r@r commit -q -m "rival deploy"
  git push -q origin main
fi
`;

const out = execFileSync('node', [path.join(__dirname, 'index.js')], {
  encoding: 'utf8',
  env: {
    ...process.env,
    'INPUT_TARGET-REPOSITORY': origin,
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_SCRIPT': script,
    'INPUT_COMMIT-MESSAGE': 'chore: bump ours',
  },
});

// --- what has to be true ----------------------------------------------------------------------
assert.ok(fs.existsSync(flag), 'the rival never pushed, so this test proved nothing');
assert.match(out, /Push rejected/, 'the first push should have been rejected');

const check = path.join(root, 'check');
git(['clone', origin, check], root);
assert.strictEqual(
  fs.readFileSync(path.join(check, 'ours.yaml'), 'utf8').trim(),
  'imageTag: "new"',
  'our bump never landed'
);
assert.strictEqual(
  fs.readFileSync(path.join(check, 'theirs.yaml'), 'utf8').trim(),
  'imageTag: "rival"',
  'the retry clobbered the deploy that won the race'
);

sh(`rm -rf ${root}`, os.tmpdir());
console.log('OK — push rejected once, retried, both deploys landed.');
