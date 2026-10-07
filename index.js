const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// GitHub exposes `with:` inputs as env vars INPUT_<NAME>, uppercased, spaces -> _.
// Dashes are preserved, so `target-repository` => INPUT_TARGET-REPOSITORY.
function getInput(name, { required = false, def = '' } = {}) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const val = (process.env[key] ?? '').trim();
  if (!val && required) {
    fail(`Input required and not supplied: ${name}`);
  }
  return val || def;
}

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

// Every backend's deploy writes a one-line imageTag edit to the SAME branch of the GitOps repo,
// so two deploys that finish close together race each other. Without a retry the loser dies with
// `! [rejected] ... (fetch first)` after its image is already in the registry: the tag never lands,
// the run goes red, and nobody is watching. Retrying is what makes a rejected push land.
//
// What retrying does NOT do is make the NEWEST deploy win: it makes the LAST pusher win. On
// 2026-10-07 two hub-service builds finished three minutes apart, the older one lost the race,
// retried, and overwrote the newer image tag five minutes after it had landed. Both runs were
// green. That is what the staleness guard below exists to stop.
// Delays in seconds; length also fixes the number of retries.
const PUSH_BACKOFF = [2, 5, 10, 20];

// Run a git command in `cwd`, inheriting stdout/stderr so logs show up in the run.
function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'inherit' });
}

// Like git() but capture stdout (trimmed). Non-zero exit throws.
function gitOut(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// --- staleness guard ---------------------------------------------------------------------
//
// Retrying replays the caller's edit on whatever is on the branch now, which is right when two
// deploys touch DIFFERENT files and wrong when they touch the same one: the later pusher wins
// regardless of which commit is newer. So every YAML file a script changes carries the time of
// the commit that produced it, and a run refuses to overwrite a marker newer than its own.
//
// It needs nothing from the caller. The timestamp comes from the push event this action is
// running inside, and the files come from what the script actually changed.
const MARKER = '# source-commit-at';

// The pushed commit's own time, as epoch seconds. Null when the workflow was not triggered by a
// push (a manual dispatch has no head_commit), in which case there is nothing to compare and the
// guard stands down rather than blocking the run.
function sourceCommitEpoch() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  try {
    const stamp = JSON.parse(fs.readFileSync(eventPath, 'utf8'))?.head_commit?.timestamp;
    if (!stamp) return null;
    const ms = Date.parse(stamp);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  } catch {
    return null;
  }
}

function readMarker(text) {
  const m = text.match(new RegExp('^' + MARKER + ': (\\d+)', 'm'));
  return m ? Number(m[1]) : null;
}

function writeMarker(text, epoch) {
  const line = `${MARKER}: ${epoch} (${new Date(epoch * 1000).toISOString().replace(/\.\d+Z$/, 'Z')})`;
  const re = new RegExp('^' + MARKER + ': .*$', 'm');
  return re.test(text) ? text.replace(re, line) : `${line}\n${text}`;
}

// Paths the script changed, as git sees them. Only YAML: the marker is a `#` comment, which is a
// comment in YAML and not in JSON or most other things a caller might edit.
function changedYamlFiles(workdir) {
  return gitOut(['status', '--porcelain'], workdir)
    .split('\n')
    // "XY path". The status field is two columns, but gitOut() trims the output, so a line whose
    // first column is blank (an unstaged edit, " M path") arrives with one letter, not two.
    .map((l) => l.replace(/^\S{1,2}\s+/, '').trim())
    .filter((f) => /\.ya?ml$/.test(f));
}

// Throws when the branch already holds a newer commit's output than ours.
function refuseIfStale(workdir, files, epoch) {
  for (const file of files) {
    let before;
    try {
      before = gitOut(['show', `HEAD:${file}`], workdir);
    } catch {
      continue; // the script created it; nothing to be older than
    }
    const theirs = readMarker(before);
    if (theirs !== null && theirs > epoch) {
      fail(
        `${file} already carries a newer source commit than this run ` +
          `(${theirs} > ${epoch}). Refusing to overwrite it with an older build. ` +
          `This run is not broken: a newer commit reached the branch first, and nothing needs redoing.`
      );
    }
  }
}

function main() {
  const targetRepository = getInput('target-repository', { required: true });
  const targetBranch = getInput('target-branch', { required: true, def: 'main' });
  const authorName = getInput('author-name', { def: 'github-actions' });
  const authorEmail = getInput('author-email', {
    def: 'github-actions@users.noreply.github.com',
  });
  const commitMessage = getInput('commit-message', { def: 'chore: update file(s) via CI' });
  const script = getInput('script', { required: true });

  // Accept a full authenticated URL, an SSH URL, a local path (test.js uses one), or "owner/repo".
  const repoUrl = /^(https?:|git@|file:|\/)/.test(targetRepository)
    ? targetRepository
    : `https://github.com/${targetRepository}.git`;

  const epoch = sourceCommitEpoch();
  if (epoch === null) {
    console.log('No push head_commit timestamp: the staleness guard stands down for this run.');
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufor-'));

  console.log(`::group::Clone target (${targetBranch})`);
  git(['clone', '--branch', targetBranch, '--single-branch', '--depth', '1', repoUrl, workdir]);
  console.log('::endgroup::');

  git(['config', 'user.name', authorName], workdir);
  git(['config', 'user.email', authorEmail], workdir);

  for (let attempt = 0; ; attempt++) {
    console.log('::group::Run script');
    // Working dir = repo root, mirroring the original action's contract.
    execSync(script, { cwd: workdir, stdio: 'inherit', shell: '/bin/bash' });
    console.log('::endgroup::');

    const status = gitOut(['status', '--porcelain'], workdir);
    if (!status) {
      // On a retry this is the good case, not a no-op: whoever won the race already wrote what we
      // were going to write.
      console.log('No changes to commit, skipping.');
      return;
    }

    // Checked after the script rather than before it, because only now do we know which files it
    // touches, and re-checked on every retry because that is when the branch has moved.
    if (epoch !== null) {
      const touched = changedYamlFiles(workdir);
      refuseIfStale(workdir, touched, epoch);
      for (const file of touched) {
        const full = path.join(workdir, file);
        fs.writeFileSync(full, writeMarker(fs.readFileSync(full, 'utf8'), epoch));
      }
    }

    git(['add', '-A'], workdir);
    git(['commit', '-m', commitMessage], workdir);

    try {
      git(['push', 'origin', `HEAD:${targetBranch}`], workdir);
      return;
    } catch (err) {
      if (attempt >= PUSH_BACKOFF.length) {
        throw err;
      }
      const delay = PUSH_BACKOFF[attempt];
      console.log(
        `Push rejected (someone else pushed to ${targetBranch} first). ` +
          `Retrying in ${delay}s — attempt ${attempt + 2} of ${PUSH_BACKOFF.length + 1}.`
      );
      execFileSync('sleep', [String(delay)], { stdio: 'inherit' });

      // Start over from what is on the branch now and re-run the script, rather than rebasing our
      // commit onto it. The script is an idempotent edit ("set imageTag to X"), so replaying it on
      // the winner's tree keeps their change and applies ours on top. Rebasing would conflict on
      // the very line both runs touch.
      console.log('::group::Reset to remote and retry');
      git(['fetch', '--depth', '1', 'origin', targetBranch], workdir);
      git(['reset', '--hard', 'FETCH_HEAD'], workdir);
      git(['clean', '-fd'], workdir);
      console.log('::endgroup::');
    }
  }
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
