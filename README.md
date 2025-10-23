# git-smart-commits

A lightweight Bun-powered CLI that stages your changes, asks an AI model for a concise commit message, and commits for you.

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
Run the tool from inside a git repository with unstaged changes:
```bash
git-smart-commit
```

The CLI will:
1. `git add --all`
2. Generate a commit message based on `git status` and the staged diff
3. Run `git commit -F -`

### Flags
- `--dry-run` &mdash; stage changes, show the suggested commit message, and leave the index staged so you can inspect it before committing manually
- `--message-only` &mdash; stage everything, print the generated commit message, and stop (useful if you want to copy/paste the message)

### Suggested shell aliases
```bash
alias gsc="git-smart-commit"
```

## Commit message style
Generated summaries follow the [Conventional Commits cheat sheet](https://gist.github.com/qoomon/5dfcdf8eec66a051ecd85625518cfd13):
- Conventional header in the form `<type>(optional scope): <description>` with types like `feat`, `fix`, `docs`, `test`, `chore`, and others.
- Lower-case, imperative descriptions under 60 characters with no trailing punctuation.
- Optional body separated by a blank line, with supporting context wrapped at ~72 characters.

## Troubleshooting
- "Missing OPENAI_API_KEY": export your API key before running `git-smart-commit`
- Empty diff: make sure you have local changes before invoking the command
- API errors: check connectivity and confirm the model name is valid for your key
