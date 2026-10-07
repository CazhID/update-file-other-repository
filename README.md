# update-file-other-repository

A tiny GitHub Action that **clones another repository, runs a shell script to modify
files in it, then commits and pushes** the result back. Handy for GitOps flows where a
build in one repo needs to bump an image tag, version, or config file in a separate repo.

- **Zero dependencies** — pure Node.js (`node20`), nothing to `npm install` or bundle.
- **Script-driven** — you provide any bash you want (`sed`, `yq`, `jq`, `echo >>`, …); it
  runs with the cloned repo as the working directory.
- **No empty commits** — if your script changes nothing, the action exits cleanly without
  committing.
- **Survives a concurrent push** — if someone else pushed to the branch first, the action
  starts over from what is on the branch now, re-runs your script, and pushes again.

## Usage

```yaml
- name: Bump version in config repo
  uses: cazhid/update-file-other-repository@v1
  with:
    target-repository: ${{ secrets.TARGET_REPO_TOKEN_URL }}
    target-branch: main
    author-name: ci-bot
    author-email: ci-bot@example.com
    commit-message: "chore: bump app version to ${{ github.sha }}"
    script: |
      sed -i 's/^version: .*/version: "${{ github.sha }}"/' config/app.yaml
```

## Inputs

| Input               | Required | Default                                     | Description |
|---------------------|:--------:|---------------------------------------------|-------------|
| `target-repository` | ✅       | —                                           | The repo to update. Either an authenticated git URL (`https://x-access-token:TOKEN@github.com/owner/repo.git`) or a plain `owner/repo` slug. |
| `target-branch`     | ✅       | `main`                                      | Branch to check out and push back to. |
| `author-name`       |          | `github-actions`                            | Git commit author name. |
| `author-email`      |          | `github-actions@users.noreply.github.com`   | Git commit author email. |
| `commit-message`    |          | `chore: update file(s) via CI`              | Commit message. |
| `script`            | ✅       | —                                           | Bash script executed **inside the cloned repo** (working directory = repo root). |

## Authentication

The action pushes to `target-repository`, so it needs write credentials. The simplest
approach is to pass an authenticated URL via a secret:

```
https://x-access-token:<TOKEN>@github.com/<owner>/<repo>.git
```

where `<TOKEN>` is a Personal Access Token (or fine-grained token) with `contents: write`
on the target repo. Store the whole URL as a repository/organization secret and reference
it as `target-repository`.

If you pass a plain `owner/repo` slug instead, the runner's ambient git credentials must
already grant push access to that repo.

## How it works

1. Clone `target-repository` at `target-branch` (`--single-branch --depth 1`).
2. Configure the commit author from `author-name` / `author-email`.
3. Run `script` with the cloned repo as the working directory.
4. If nothing changed, skip. Otherwise `git add -A`, commit with `commit-message`, and push.
5. If the push is rejected because another run pushed first, reset to the branch's new head,
   re-run `script` on top of it, and push again — up to four retries, backing off 2s, 5s, 10s,
   then 20s.

### Why it retries by re-running the script, not by rebasing

The common case is several repos bumping an image tag in the **same** GitOps file. Two runs
therefore touch the same line, which is exactly where a rebase conflicts. Re-running the script
sidesteps that: a script that sets a value (`sed -i 's/^imageTag: .*/imageTag: "X"/'`) produces
the same result on any starting tree, so it keeps whatever the winning run wrote elsewhere and
applies your change on top. **Write the script to set a value, not to append or increment one** —
an appending script would run twice and append twice.

Without the retry the loser exits with `! [rejected] ... (fetch first)` after its image is already
in the registry: the tag never lands and the run goes red. That failure is easy to miss, and since
the loser is usually the later run, it leaves the *older* image deployed.

## Tests

```
node test.js
```

No framework, no network. It stands up a bare repo, has the script push a competing commit the
first time it runs so the first push is guaranteed to be rejected, and asserts both that the retry
landed our change and that it did not clobber the run that won the race.

## License

MIT

## Staleness guard

Retrying a rejected push makes the **last** pusher win, not the newest commit. When two deploys
touch the same file, the loser replays its edit on the winner's tree, so an older build can
overwrite a newer image tag with both runs green. That happened to `hub-service` on 2026-10-07:
the 02:43 commit replaced the 02:46 one five minutes after it landed, and the only symptom was a
screen that did not change.

So every YAML file a script changes gets a line recording the time of the commit that produced it:

```yaml
# source-commit-at: 1791358939 (2026-10-07T02:46:19Z)
imageTag: "v1.0.0-production-abc1234"
```

A run that would replace a marker newer than its own **fails** instead, before pushing. The check
runs after the script (that is when the changed files are known) and again on every retry (that is
when the branch has moved).

Nothing to configure. The commit time comes from the push event the action is running inside, and
the files come from what the script actually changed. Two deliberate limits:

- **YAML only** (`.yaml` / `.yml`). The marker is a `#` comment, which is a comment in YAML and not
  in JSON or most other things a caller might edit.
- **Push events only.** A `workflow_dispatch` has no `head_commit`, so there is nothing to compare
  and the guard stands down rather than blocking the run.

A refused run is not a broken one: a newer commit reached the branch first, and nothing needs
redoing. The error message says so.
