# update-file-other-repository

A tiny GitHub Action that **clones another repository, runs a shell script to modify
files in it, then commits and pushes** the result back. Handy for GitOps flows where a
build in one repo needs to bump an image tag, version, or config file in a separate repo.

- **Zero dependencies** — pure Node.js (`node20`), nothing to `npm install` or bundle.
- **Script-driven** — you provide any bash you want (`sed`, `yq`, `jq`, `echo >>`, …); it
  runs with the cloned repo as the working directory.
- **No empty commits** — if your script changes nothing, the action exits cleanly without
  committing.

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

## License

MIT
