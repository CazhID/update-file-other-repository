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

  // Accept a full authenticated URL, an SSH URL, or "owner/repo".
  const repoUrl = /^(https?:|git@)/.test(targetRepository)
    ? targetRepository
    : `https://github.com/${targetRepository}.git`;

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufor-'));

  console.log(`::group::Clone target (${targetBranch})`);
  git(['clone', '--branch', targetBranch, '--single-branch', '--depth', '1', repoUrl, workdir]);
  console.log('::endgroup::');

  git(['config', 'user.name', authorName], workdir);
  git(['config', 'user.email', authorEmail], workdir);

  console.log('::group::Run script');
  // Working dir = repo root, mirroring the original action's contract.
  execSync(script, { cwd: workdir, stdio: 'inherit', shell: '/bin/bash' });
  console.log('::endgroup::');

  const status = gitOut(['status', '--porcelain'], workdir);
  if (!status) {
    console.log('No changes to commit — skipping.');
    return;
  }

  git(['add', '-A'], workdir);
  git(['commit', '-m', commitMessage], workdir);
  git(['push', 'origin', `HEAD:${targetBranch}`], workdir);
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
