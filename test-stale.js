// Proves the thing the retry got wrong: when two deploys touch the SAME file, replaying the
// loser's edit on the winner's tree makes the LAST pusher win, even carrying an older commit.
// That is what put hub-service back to an older image on 2026-10-07.
//
// Run: node test-stale.js   (needs git; no framework, no network)

const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ufor-stale-'));
const origin = path.join(root, 'origin.git');
const seed = path.join(root, 'seed');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commitAll = (repo, m) => {
  git(['add', '-A'], repo);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', m], repo);
};

git(['init', '--bare', '-b', 'main', origin], root);
git(['clone', origin, seed], root);
fs.writeFileSync(path.join(seed, 'values.yaml'), 'imageTag: "old"\n');
commitAll(seed, 'seed');
git(['push', 'origin', 'main'], seed);

// A push event payload, so the action can read the commit time it is deploying.
function eventFile(iso) {
  const f = path.join(root, `event-${Date.parse(iso)}.json`);
  fs.writeFileSync(f, JSON.stringify({ head_commit: { timestamp: iso } }));
  return f;
}

function run(iso, tag) {
  return execFileSync('node', [path.join(__dirname, 'index.js')], {
    env: {
      ...process.env,
      GITHUB_EVENT_PATH: eventFile(iso),
      'INPUT_TARGET-REPOSITORY': origin,
      'INPUT_TARGET-BRANCH': 'main',
      INPUT_SCRIPT: `perl -i -pe 's/^imageTag: .*$/imageTag: "${tag}"/' values.yaml`,
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function head() {
  const c = path.join(root, `check-${Date.now()}-${Math.random()}`);
  git(['clone', origin, c], root);
  return fs.readFileSync(path.join(c, 'values.yaml'), 'utf8');
}

// 1. the newer build lands and stamps the file
run('2026-10-07T02:46:00Z', 'newer');
let f = head();
assert.match(f, /imageTag: "newer"/, 'the newer build should land');
assert.match(f, /^# source-commit-at: \d+ \(2026-10-07T02:46:00Z\)$/m, 'it should stamp its commit time');

// 2. the OLDER build, pushing afterwards, must be refused
let refused = false;
try {
  run('2026-10-07T02:43:00Z', 'older');
} catch (err) {
  refused = true;
  assert.match(String(err.stderr), /Refusing to overwrite it with an older build/);
  assert.match(String(err.stderr), /nothing needs redoing/);
}
assert.ok(refused, 'the older build must fail, not win');
assert.match(head(), /imageTag: "newer"/, 'the older build must not have changed the tag');

// 3. a genuinely newer build still lands
run('2026-10-08T05:00:00Z', 'newest');
assert.match(head(), /imageTag: "newest"/, 'a newer build must still deploy');

// 4. no push event (a manual dispatch) still works, guard stands down
const out = execFileSync('node', [path.join(__dirname, 'index.js')], {
  env: {
    ...process.env,
    GITHUB_EVENT_PATH: '',
    'INPUT_TARGET-REPOSITORY': origin,
    'INPUT_TARGET-BRANCH': 'main',
    INPUT_SCRIPT: `perl -i -pe 's/^imageTag: .*$/imageTag: "manual"/' values.yaml`,
  },
  encoding: 'utf8',
});
assert.match(out, /guard stands down/);
assert.match(head(), /imageTag: "manual"/, 'a manual run must not be blocked');

console.log('OK — an older build is refused, a newer one lands, a manual run is unaffected.');
