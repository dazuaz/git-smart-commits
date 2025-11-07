# git-smart-commits

A lightweight Bun-powered CLI that stages your changes, asks an AI model for a concise commit message, and commits for you. Now with an intelligent **commit agent** that groups changes logically and creates multiple Conventional Commits automatically.

## Prerequisites
- [Bun](https://bun.sh/) 1.3 or newer
- An OpenAI-compatible API key exported as `OPENAI_API_KEY`

Optional environment variables:
- `GIT_SMART_MODEL` or `OPENAI_MODEL` to override the default (`gpt-4o-mini`)
- `GIT_SMART_TEMPERATURE` or `OPENAI_TEMPERATURE` (defaults to `0.2`)
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

### Single Commit Mode (Default)

Run the tool from inside a git repository with unstaged changes:
```bash
git-smart-commit
```

The CLI will:
1. `git add --all`
2. Generate a commit message based on `git status` and the staged diff
3. Run `git commit -F -`

**Flags:**
- `--dry-run` &mdash; stage changes, show the suggested commit message, and leave the index staged so you can inspect it before committing manually
- `--message-only` &mdash; stage everything, print the generated commit message, and stop (useful if you want to copy/paste the message)

### Agent Mode (Multi-Commit)

The commit agent intelligently groups your changes and creates multiple logical commits:

```bash
git-smart-commit --agent
```

The agent follows a **Sense → Think/Plan → Act → Critique → Report** loop:

1. **Sense**: Reads git status and diffs (staged + optionally unstaged)
2. **Think/Plan**: Uses LLM to identify logical change groups and draft commit messages
3. **Act**: Stages and commits each group sequentially
4. **Critique**: Optional self-review of commit quality
5. **Report**: Summary of commits created

**Agent Mode Flags:**
- `--agent` &mdash; Enable agent mode (required)
- `--auto` &mdash; No prompts, commit all groups automatically
- `--confirm` &mdash; Ask for confirmation before each commit (default when not using `--auto`)
- `--plan-only` &mdash; Print proposed groups and messages, do nothing
- `--include-unstaged` &mdash; Include unstaged changes in analysis
- `--no-critique` &mdash; Skip the critique/QA step
- `--dry-run` &mdash; Show what would be committed without actually committing
- `--max-groups=N` &mdash; Limit the number of commit groups (e.g., `--max-groups=5`)
- `--only-types=TYPES` &mdash; Only create commits of specified types (e.g., `--only-types=feat,fix`)

**Examples:**
```bash
# Preview the commit plan without committing
git-smart-commit --agent --plan-only

# Auto-commit all groups without prompts
git-smart-commit --agent --auto

# Confirm each commit interactively
git-smart-commit --agent --confirm

# Include unstaged changes and limit to 3 groups
git-smart-commit --agent --include-unstaged --max-groups=3

# Only create feat and fix commits
git-smart-commit --agent --only-types=feat,fix
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
