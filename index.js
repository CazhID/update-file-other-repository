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
// the run goes red, and nobody is watching. Worse, the loser is usually the LATER run, so the
// older image is the one that stays deployed. Retrying is what makes the newest deploy win.
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
      console.log('No changes to commit — skipping.');
      return;
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
