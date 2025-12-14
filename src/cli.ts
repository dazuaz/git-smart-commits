/// <reference path="./globals.d.ts" />

import type { AgentConfig, LLMConfig, ConventionalType } from "./types.js";
import { agenticCommit } from "./agent.js";

function printHelp(): void {
  console.log(`git-smart-commit

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

Usage:
  git-smart-commit [--plan-only] [--dry-run]

Options:
  --plan-only   Print the proposed commit plan, do nothing
  --dry-run     Show what would be committed, do not commit
  --help        Show this help

  // Parse agent flags
  const auto = flags.has("--auto");
  const confirm = flags.has("--confirm") && !auto;
  const planOnly = flags.has("--plan-only");
  const includeUnstaged = flags.has("--include-unstaged");
  const noCritique = flags.has("--no-critique");
  const dryRun = flags.has("--dry-run");
  const useHunkStaging = flags.has("--use-hunks");

  // Parse --max-groups
  let maxGroups: number | undefined;
  const maxGroupsArg = args.find((a) => a.startsWith("--max-groups="));
  if (maxGroupsArg) {
    maxGroups = parseInt(maxGroupsArg.split("=")[1] || "0", 10) || undefined;
  }

  // Parse --only-types
  let onlyTypes: ConventionalType[] | undefined;
  const onlyTypesArg = args.find((a) => a.startsWith("--only-types="));
  if (onlyTypesArg) {
    const types = onlyTypesArg.split("=")[1]?.split(",").map((t) => t.trim()) || [];
    onlyTypes = types.filter((t) =>
      CONVENTIONAL_TYPES.includes(t as ConventionalType)
    ) as ConventionalType[];
  }

  const agentConfig: AgentConfig = {
    auto,
    confirm,
    planOnly,
    includeUnstaged,
    maxGroups,
    onlyTypes,
    noCritique,
    dryRun,
    messageOnly: false,
    useHunkStaging,
  };

  try {
    await agenticCommit(agentConfig, llmConfig);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args);

  if (flags.has("--help") || flags.has("-h")) {
    printHelp();
    return;
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
  const branch = getBranchName(status);
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

  const llmConfig: LLMConfig = { apiKey, model, temperature, baseUrl };

  const config: AgentConfig = {
    planOnly: flags.has("--plan-only"),
    dryRun: flags.has("--dry-run"),
  };
}

function normalizeDescription(input: string) {
  const collapsedWhitespace = input.replace(/\s+/g, " ").trim();
  if (!collapsedWhitespace) {
    return "";
  }

  const withoutTrailingPunctuation = collapsedWhitespace.replace(
    /[.!?,;:]+$/,
    "",
  );
  if (!withoutTrailingPunctuation) {
    return "";
  }

  return (
    withoutTrailingPunctuation[0].toLowerCase() +
    withoutTrailingPunctuation.slice(1)
  );
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

  let type = "chore";
  let scope = "";
  let description = "";

  const headerMatch = header.match(/^([a-zA-Z]+)(\([^)]+\))?:\s*(.+)$/);
  if (headerMatch) {
    [, type, scope = "", description] = headerMatch;
    type = type.toLowerCase();

    if (!CONVENTIONAL_TYPES.includes(type)) {
      type = "chore";
    }

    if (scope) {
      const scopeName = scope.slice(1, -1).trim();
      scope = scopeName ? `(${scopeName.toLowerCase()})` : "";
    }

    description = normalizeDescription(description);
    if (!description) {
      throw new Error("Commit summary description cannot be empty.");
    }
  } else {
    const fallbackDescription = normalizeDescription(
      header.replace(/^[-*#\s]+/, ""),
    );

    if (!fallbackDescription) {
      throw new Error(
        "Commit message must start with <type>(optional scope): <description>.",
      );
    }

    description = fallbackDescription;
    if (message.trim().length) {
      console.warn(
        "Commit message missing Conventional Commit header. Defaulting to chore.",
      );
    }
  }

  const normalizedHeader = scope
    ? `${type}${scope}: ${description}`
    : `${type}: ${description}`;

  return [normalizedHeader, ...body].join("\n");
}

function parseBranchFromStatus(status: string | undefined) {
  if (!status) {
    return undefined;
  }

  const firstLine = status.split("\n")[0]?.trim();
  if (!firstLine?.startsWith("##")) {
    return undefined;
  }

  let branchHint = firstLine.slice(2).trim();
  if (!branchHint) {
    return undefined;
  }

  if (branchHint.startsWith("No commits yet on ")) {
    branchHint = branchHint.replace("No commits yet on ", "").trim();
  }

  if (branchHint.includes("...")) {
    branchHint = branchHint.split("...")[0]?.trim() ?? branchHint;
  }

  if (branchHint === "HEAD (no branch)") {
    return "detached";
  }

  return branchHint || undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
