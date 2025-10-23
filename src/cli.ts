const decoder = new TextDecoder();
const encoder = new TextEncoder();

const CONVENTIONAL_TYPES = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
];

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
};

async function main() {
  ensureGitRepository();

  const args = process.argv.slice(2);
  const flags = new Set(args);
  const dryRun = flags.has("--dry-run");
  const messageOnly = flags.has("--message-only");

  if (dryRun && messageOnly) {
    console.error("Use either --dry-run or --message-only, not both.");
    process.exit(1);
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.error("Missing OPENAI_API_KEY environment variable.");
    process.exit(1);
  }

  const model =
    process.env.GIT_SMART_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    "gpt-4o-mini";
  const temperature = parseFloat(
    process.env.GIT_SMART_TEMPERATURE ?? process.env.OPENAI_TEMPERATURE ?? "0.2",
  );

  stageAllChanges();

  const diff = getStagedDiff();
  if (!diff.trim()) {
    console.log("No staged changes detected. Nothing to commit.");
    process.exit(0);
  }

  const status = getStatusSummary();
  const branch = getBranchName();
  const repo = getRepoName();

  const prompt = buildPrompt({ repo, branch, status, diff });
  const baseUrl =
    process.env.GIT_SMART_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.openai.com";
  const rawCommitMessage = await requestCommitMessage({
    apiKey,
    model,
    temperature,
    baseUrl,
    prompt,
  });

  const trimmedCommitMessage = rawCommitMessage.trim();
  if (!trimmedCommitMessage) {
    console.error("The AI response was empty. Aborting.");
    process.exit(1);
  }

  const commitMessage = sanitizeCommitMessage(trimmedCommitMessage);

  if (messageOnly) {
    console.log(commitMessage.trimEnd());
    process.exit(0);
  }

  if (dryRun) {
    console.log("Suggested commit message:\n");
    console.log(commitMessage.trimEnd());
    process.exit(0);
  }

  commitWithMessage(commitMessage);
}

function ensureGitRepository() {
  const result = exec(["git", "rev-parse", "--is-inside-work-tree"]);
  if (result.code !== 0 || result.stdout.trim() !== "true") {
    console.error("This command must be run inside a Git repository.");
    process.exit(1);
  }
}

function stageAllChanges() {
  const result = exec(["git", "add", "--all"]);
  if (result.code !== 0) {
    console.error("Failed to stage changes:\n" + result.stderr.trim());
    process.exit(result.code);
  }
}

function getStagedDiff(): string {
  const result = exec(["git", "diff", "--cached"]);
  if (result.code !== 0) {
    console.error("Failed to read staged diff:\n" + result.stderr.trim());
    process.exit(result.code);
  }
  const diff = result.stdout.trim();
  if (diff.length > 80_000) {
    console.warn(
      "Warning: staging diff larger than 80k characters. Truncating for prompt.",
    );
    return diff.slice(0, 80_000);
  }
  return diff;
}

function getStatusSummary(): string {
  const result = exec(["git", "status", "-sb"]);
  if (result.code !== 0) {
    console.error("Failed to read git status:\n" + result.stderr.trim());
    process.exit(result.code);
  }
  return result.stdout.trim();
}

function getBranchName(): string {
  const result = exec(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  if (result.code !== 0) {
    console.error("Failed to read branch name:\n" + result.stderr.trim());
    process.exit(result.code);
  }
  return result.stdout.trim();
}

function getRepoName(): string {
  const result = exec(["git", "rev-parse", "--show-toplevel"]);
  if (result.code !== 0) {
    console.error("Failed to read repository name:\n" + result.stderr.trim());
    process.exit(result.code);
  }

  const path = result.stdout.trim();
  const segments = path.split("/");
  return segments[segments.length - 1] || path;
}

function buildPrompt({
  repo,
  branch,
  status,
  diff,
}: {
  repo: string;
  branch: string;
  status: string;
  diff: string;
}) {
  const typeList = CONVENTIONAL_TYPES.join(", ");

  return `Repository: ${repo}
Branch: ${branch}
Status:
${status}

Provide a high-quality Conventional Commit message for the staged changes below.
Format the first line exactly as:
<type>(optional scope): <short description under 60 characters>

Follow these rules:
- Use one of these lower-case types: ${typeList}
- Keep the description in the imperative mood, lower case, no trailing punctuation
- Only include a scope if it clarifies the change
- Add an optional body separated by a blank line, wrapping lines at 72 characters
- Focus the body on the "what" and "why" when additional context is helpful

Diff:
${diff}`;
}

async function requestCommitMessage({
  apiKey,
  model,
  temperature,
  baseUrl,
  prompt,
}: {
  apiKey: string;
  model: string;
  temperature: number;
  baseUrl: string;
  prompt: string;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const endpoint =
      baseUrl.endsWith("/")
        ? `${baseUrl}v1/chat/completions`
        : `${baseUrl}/v1/chat/completions`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are an expert software engineer who crafts thoughtful Conventional Commit messages. Always respond with a single commit message. Start with <type>(optional scope): <description> where type is one of build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test. Keep everything lower case, imperative, and avoid trailing punctuation. If you include a body, separate it with a blank line and wrap lines at 72 characters.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature,
        max_tokens: 200,
        n: 1,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `OpenAI API request failed (${response.status}): ${text}`,
      );
    }

    const json = (await response.json()) as {
      choices: Array<{ message?: { content?: string } }>;
    };

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI API returned no content.");
    }

    return content.trim();
  } finally {
    clearTimeout(timeout);
  }
}

function commitWithMessage(message: string) {
  const normalized = message.endsWith("\n") ? message : `${message}\n`;

  const commit = Bun.spawnSync({
    cmd: ["git", "commit", "-F", "-"],
    stdin: encoder.encode(normalized),
    stdout: "inherit",
    stderr: "inherit",
  });

  if (commit.exitCode !== 0) {
    console.error("git commit failed.");
    process.exit(commit.exitCode ?? 1);
  }
}

function exec(cmd: string[]): ExecResult {
  const result = Bun.spawnSync({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    stdout: decoder.decode(result.stdout ?? new Uint8Array()),
    stderr: decoder.decode(result.stderr ?? new Uint8Array()),
    code: result.exitCode ?? 1,
  };
}

function sanitizeCommitMessage(message: string) {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, array) => {
      if (line !== "") {
        return true;
      }

      const isLast = index === array.length - 1;
      const nextLine = array[index + 1];
      return !isLast && nextLine !== "";
    });

  const [header, ...body] = lines;
  if (!header) {
    throw new Error("Commit message is missing a summary line.");
  }

  const headerMatch = header.match(/^([a-zA-Z]+)(\([^)]+\))?:\s*(.+)$/);
  if (!headerMatch) {
    throw new Error(
      "Commit message must start with <type>(optional scope): <description>.",
    );
  }

  let [, type, scope = "", description] = headerMatch;
  type = type.toLowerCase();

  if (!CONVENTIONAL_TYPES.includes(type)) {
    type = "chore";
  }

  if (scope) {
    const scopeName = scope.slice(1, -1).trim();
    scope = scopeName ? `(${scopeName.toLowerCase()})` : "";
  }

  description = description.trim();
  description = description.replace(/[.!?,;:]+$/, "");
  if (description.length > 0) {
    description = description[0].toLowerCase() + description.slice(1);
  }
  if (!description) {
    throw new Error("Commit summary description cannot be empty.");
  }

  const normalizedHeader = scope
    ? `${type}${scope}: ${description}`
    : `${type}: ${description}`;

  return [normalizedHeader, ...body].join("\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
