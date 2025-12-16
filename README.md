# git-smart-commits

A lightweight Bun-powered CLI that uses an AI model to produce clean Conventional Commit messages and commit your changes. By default it creates 1 squashed commit; with `--split` it can create 1..N logical commits.

## Prerequisites
- [Bun](https://bun.sh/) 1.3 or newer
- An OpenAI-compatible API key exported as `OPENAI_API_KEY`

Optional environment variables:
- `GIT_SMART_MODEL` or `OPENAI_MODEL` to override the default (`gpt-5-nano-2025-08-07`)
- `GIT_SMART_TEMPERATURE` or `OPENAI_TEMPERATURE` (defaults to `1`; ignored by some models like `gpt-5-nano-2025-08-07`)
- `OPENAI_BASE_URL` if you are using an OpenAI-compatible endpoint

## Install & build
```bash
bun run build
chmod +x bin/git-smart-commit
```

The build step uses Bun's bundler to emit a standalone executable in `bin/git-smart-commit`. For details, see [Bun bundler executables](https://bun.com/docs/bundler/executables).

(Optional) Add the binary to your PATH:
```bash
cp bin/git-smart-commit ~/.local/bin/
```

## Usage

Run the tool from inside a git repository with changes:
```bash
git-smart-commit
```

**API note:** For GPT‑5 models, the tool uses the OpenAI **Responses API** (recommended in the docs). For other models and some OpenAI‑compatible endpoints, it falls back to **Chat Completions**.

The CLI will:
1. Choose what to include (staged by default; if only unstaged exists it uses that; use `--interactive` to be prompted when both staged and unstaged exist)
2. Ask the model for either a single squashed commit message (default) or a 1..N commit plan (`--split`)
3. Show the proposed message(s)
4. Commit (non-interactive by default; use `--interactive` to confirm)

**Flags:**
- `--plan-only` &mdash; print the proposed plan/messages, do nothing
- `--dry-run` &mdash; simulate staging/commits without committing
- `--debug` &mdash; print progress/timing to stderr (useful if it feels stuck)
- `--interactive` &mdash; prompt before including/committing changes
- `--squash` &mdash; create 1 squashed commit (default)
- `--split` &mdash; create 1..N commits from the plan instead of squashing

**Examples:**
```bash
# Preview the squashed commit message without committing
git-smart-commit --plan-only

# Simulate what would be committed
git-smart-commit --dry-run

# Create multiple commits (one per group)
git-smart-commit --split --interactive
```

### Suggested shell aliases
```bash
alias gsc="git-smart-commit"
```

## Commit message style

Generated summaries follow the [Conventional Commits cheat sheet](https://gist.github.com/qoomon/5dfcdf8eec66a051ecd85625518cfd13):
- Conventional header in the form `<type>(optional scope): <description>` with types like `feat`, `fix`, `docs`, `test`, `chore`, and others.
- Lower-case, imperative descriptions under 60 characters with no trailing punctuation.
- Optional body separated by a blank line, with supporting context wrapped at ~72 characters.

### How the Agent Groups Changes

The agent uses a combination of **heuristics** and **LLM semantics** to group changes:

**Heuristics (fast, deterministic):**
- Groups by top-level directory or package (e.g., `apps/web`, `packages/ui`)
- Splits code vs tests vs docs
- Separates lockfile and format-only changes
- Detects generated/vendor files

**LLM Semantics (resolves ambiguous hunks):**
- Analyzes file hunks with context
- Assigns type, scope, and rationale per group
- Merges tiny groups into logical neighbors

**Example grouping outcome:**
```
Plan:
- fix(router): handle 404 for nested routes
  body: the route matcher now returns the parent index ...
  files: apps/web/src/router.ts, apps/web/src/__tests__/router.test.ts

- chore(deps): bump axios to 1.7.3
  files: package.json, package-lock.json

- docs(readme): add usage for auth middleware
  files: README.md
```

## Troubleshooting
- "Missing OPENAI_API_KEY": export your API key before running `git-smart-commit`
- Empty diff: make sure you have local changes before invoking the command
- API errors: check connectivity and confirm the model name is valid for your key
- `Failed to parse LLM response as JSON`: this only affects `--split`; try the default squash mode or rerun with `--debug` to capture details
