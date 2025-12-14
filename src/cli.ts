/// <reference path="./globals.d.ts" />

import type { AgentConfig, LLMConfig } from "./types.js";
import { smartCommit } from "./agent.js";

function printHelp(): void {
  console.log(`git-smart-commit

Creates Conventional Commit messages and commits your changes using an AI model.

Usage:
  git-smart-commit [--plan-only] [--dry-run] [--debug]

Options:
  --plan-only   Print the proposed commit plan, do nothing
  --dry-run     Show what would be committed, do not commit
  --debug       Print progress/timing to stderr
  --help        Show this help

Environment:
  OPENAI_API_KEY                 Required
  GIT_SMART_MODEL / OPENAI_MODEL  Model name (default: gpt-4o-mini)
  GIT_SMART_TEMPERATURE / OPENAI_TEMPERATURE (default: 0.2)
  GIT_SMART_BASE_URL / OPENAI_BASE_URL (default: https://api.openai.com)
  GIT_SMART_DEBUG=1              Enable debug logging
`);
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args);

  if (flags.has("--help") || flags.has("-h")) {
    printHelp();
    return;
  }

  if (flags.has("--debug")) {
    process.env.GIT_SMART_DEBUG = "1";
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
  const baseUrl =
    process.env.GIT_SMART_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.openai.com";

  const llmConfig: LLMConfig = { apiKey, model, temperature, baseUrl };

  const config: AgentConfig = {
    planOnly: flags.has("--plan-only"),
    dryRun: flags.has("--dry-run"),
  };

  if (config.planOnly && config.dryRun) {
    console.error("Use either --plan-only or --dry-run, not both.");
    process.exit(1);
  }

  await smartCommit(config, llmConfig);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
