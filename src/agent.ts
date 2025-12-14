import type {
  AgentConfig,
  LLMConfig,
  GroupPlan,
  Hunk,
} from "./types.js";
import {
  ensureGitRepository,
  getStatusSummary,
  getBranchName,
  getRepoName,
  collectHunks,
  buildPatchForGroup,
  applyPatchToIndex,
  unstagePatch,
  getDiffSummary,
  commitWithMessage,
  stageFiles,
  unstageFiles,
  clearStagingArea,
  getStagedDiff,
} from "./git.js";
import { requestGroupPlan, critiqueAndRefinePlan, checkLeakageLLM, critiqueCommitMessage } from "./llm.js";
import { summarizeHunks } from "./grouping.js";

export async function smartCommit(
  config: AgentConfig,
  llmConfig: LLMConfig,
): Promise<void> {
  ensureGitRepository();

  // 1) Sense
  const status = getStatusSummary();
  const repo = getRepoName();
  const branch = getBranchName(status);

  const initialStagedDiff = getStagedDiff();
  const initialUnstagedDiff = getUnstagedDiff();
  const initialUntracked = listUntrackedFiles();

  if (
    !initialStagedDiff.trim() &&
    !initialUnstagedDiff.trim() &&
    initialUntracked.length === 0
  ) {
    console.log("No changes detected. Nothing to commit.");
    return;
  }

  // If both staged and unstaged exist, choose whether to operate on staged-only
  // or on all working-tree changes. We prefer staged-only by default to avoid
  // surprising commits.
  const hasStaged = initialStagedDiff.trim().length > 0;
  const hasUnstaged = initialUnstagedDiff.trim().length > 0 || initialUntracked.length > 0;
  const includeAll =
    hasStaged && hasUnstaged
      ? await promptYesNo(
          "Include unstaged/untracked changes too? (y/N): ",
          false,
        )
      : !hasStaged;

  const stagedSnapshot = getStagedPatch();
  let committedAny = false;

  let plan: GroupPlan[];
  try {
    // Normalize the index so we can stage precisely per group without depending
    // on whatever the user had staged previously.
    //
    // - Staged-only: we plan from the staged diff we already captured.
    // - All changes: we clear the index and plan from the working tree diff.
    const diffForPlanning = includeAll
      ? prepareAllChangesDiff()
      : initialStagedDiff;

    const hunks = collectHunksFromDiff(diffForPlanning);
    if (hunks.length === 0) {
      console.log("No diff hunks detected. Nothing to commit.");
      return;
    }

    const plan = await requestGroupPlan(llmConfig, repo, branch, status, hunks);
    if (plan.length === 0) {
      console.log("No logical commit groups identified.");
      return;
    }

    validatePlanForSharedFiles(plan);

    printPlan(plan);
    if (config.planOnly) {
      return;
    }

    const proceed = await promptYesNo(
      `Proceed to ${config.dryRun ? "simulate" : "create"} ${plan.length} commit(s)? (y/N): `,
      false,
    );
    plan = plan.slice(0, config.maxGroups);
  }

    const fileGroupCounts = countFilesAcrossGroups(plan);
    const sharedFiles = new Set(
      [...fileGroupCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([file]) => file),
    );

    const committed: GroupPlan[] = [];
    const skipped: GroupPlan[] = [];

    for (let i = 0; i < plan.length; i++) {
      const group = plan[i];
      console.log(`\n[${i + 1}/${plan.length}] ${formatGroupHeader(group)}`);

      const message = formatConventionalCommit(group);
      console.log(`\nProposed commit message:\n${message}\n`);
      console.log(`Files: ${group.files.join(", ")}`);
      if (group.rationale) {
        console.log(`Rationale: ${group.rationale}`);
      }

      const accepted = await promptYesNo("Commit? (y/N): ", false);
      if (!accepted) {
        console.log("  Skipped by user");
        skipped.push(group);
        continue;
      }

      // Stage the changes for this group.
      if (!clearStagingArea()) {
        console.error("  Failed to clear staging area.");
        skipped.push(group);
        continue;
      }

      const stagedOk = stageGroup(group, sharedFiles);
      if (!stagedOk) {
        console.error("  Failed to stage this group.");
        clearStagingArea();
        skipped.push(group);
        continue;
      }

      const stagedDiff = getStagedDiff();
      if (!stagedDiff.trim()) {
        console.warn("  Skipping: no changes staged");
        clearStagingArea();
        skipped.push(group);
        continue;
      }
    }

    // Verify we have staged changes
    const stagedCheck = getStagedDiff();
    if (!stagedCheck.trim()) {
      console.warn("  Skipping: no changes staged");
      clearStagingArea();
      skipped.push(group);
      continue;
    }

    const message = formatConventionalCommit(group);

    // User confirmation
    if (config.confirm && !config.auto) {
      console.log(`\nProposed commit message:\n${message}\n`);
      const accepted = await userAccepts(group, message);
      if (!accepted) {
        console.log("  Skipped by user");
        // Unstage this group
        clearStagingArea();
        skipped.push(group);
        continue;
      }
    } else if (!config.auto) {
      console.log(`\nCommit message:\n${message}\n`);
    }

    // Optional critique
    if (!config.noCritique && !config.dryRun) {
      const diffSummary = summarizeHunks(group.hunks, 2000);
      const critique = await critiqueCommitMessage(llmConfig, message, diffSummary);
      if (!critique.ok && critique.suggestedMessage) {
        console.warn(`  Critique suggests: ${critique.suggestedMessage}`);
        if (config.confirm && !config.auto) {
          const useSuggested = await userAccepts(group, critique.suggestedMessage);
          if (useSuggested) {
            // Re-commit with suggested message
            if (commitWithMessage(critique.suggestedMessage)) {
              committed.push(group);
              continue;
            }
          }
        }
      }
    }

    // Commit
    if (config.dryRun) {
      console.log("  [DRY RUN] Would commit with message above");
      committed.push(group);
      // Unstage for dry run so next group can stage fresh
      clearStagingArea();
    } else {
      if (commitWithMessage(message)) {
        committed.push(group);

        // 5) Verify commit scope leakage (optional)
        if (!config.noCritique) {
          const residual = getDiffSummary();
          const leakage = await checkLeakageLLM(llmConfig, message, residual);
          if (leakage.hasLeak) {
            console.warn(
              `  Potential scope leakage detected: ${leakage.message || "Consider follow-up commits."}`
            );
          }
        }
      } else {
        console.error("  Commit failed");
        skipped.push(group);
      }
    }
  }

  // 6) Report
  printSummary(committed, skipped);
}

function formatGroupHeader(group: GroupPlan): string {
  const scope = group.scope ? `(${group.scope})` : "";
  const additionalTypesStr = group.additionalTypes?.length
    ? ` [+${group.additionalTypes.join(", +")}]`
    : "";
  return `${group.type}${scope}: ${group.title}${additionalTypesStr}`;
}

export function formatConventionalCommit(group: GroupPlan): string {
  const scope = group.scope ? `(${group.scope})` : "";
  const header = `${group.type}${scope}: ${group.title}`;

  // Build body with additional types note if present
  const bodyParts: string[] = [];

  if (group.body) {
    bodyParts.push(group.body);
  }

  // Add note about additional change types
  if (group.additionalTypes?.length) {
    const typesNote = `Also includes: ${group.additionalTypes.join(", ")}`;
    bodyParts.push(typesNote);
  }

  if (bodyParts.length > 0) {
    return `${header}\n\n${bodyParts.join("\n\n")}`;
  }

  return header;
}

async function userAccepts(
  group: GroupPlan,
  message: string
): Promise<boolean> {
  // Simple stdin read for yes/no
  // In a real implementation, you might use a library like readline
  process.stdout.write("Commit? (y/n): ");
  
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const handler = (char: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", handler);

      if (char === "y" || char === "Y" || char === "\r" || char === "\n") {
        resolve(true);
      } else {
        resolve(false);
      }
    };

    stdin.once("data", handler);
  });
}

function printPlan(plan: GroupPlan[]): void {
  console.log("\n=== Commit Plan ===\n");
  for (let i = 0; i < plan.length; i++) {
    const group = plan[i];
    console.log(`${i + 1}. ${formatGroupHeader(group)}`);
    if (group.additionalTypes?.length) {
      console.log(`   Also: ${group.additionalTypes.join(", ")}`);
    }
    if (group.body) {
      console.log(`   ${group.body.split("\n").join("\n   ")}`);
    }
    console.log(`   Files: ${group.files.join(", ")}`);
    console.log(`   Rationale: ${group.rationale}`);
    console.log();
  }
}

function printSummary(committed: GroupPlan[], skipped: GroupPlan[]): void {
  console.log("\n=== Summary ===\n");
  console.log(`Committed: ${committed.length}`);
  for (const group of committed) {
    console.log(`  ✓ ${formatGroupHeader(group)}`);
  }

  if (skipped.length > 0) {
    console.log(`\nSkipped: ${skipped.length}`);
    for (const group of skipped) {
      console.log(`  ✗ ${formatGroupHeader(group)}`);
    }
  }
}


