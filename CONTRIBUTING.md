# Contributing

Thanks for your interest in improving git-smart-commits.

## Development setup

- Install [Bun](https://bun.sh/) 1.3 or newer.
- Clone the repository and install dependencies (if any are added later):

  ```bash
  bun install
  ```

  The `prepare` script builds the standalone binary in `bin/`; [Bun](https://bun.sh/) must be on your `PATH`.

- Never commit secrets (for example API keys). Use environment variables as described in the README.

- Run from source:

  ```bash
  bun run dev -- --help
  ```

- Build the standalone binary:

  ```bash
  bun run build
  ```

  The executable is written to `bin/git-smart-commit` (this path is gitignored).

## Pull requests

- Keep changes focused on a single concern when possible.
- Update `README.md` if you change user-visible behavior, flags, or environment variables.
- If you fix a bug, a short note in the PR describing how to reproduce the issue helps reviewers.

## Security

Please do not open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for how to report them.
