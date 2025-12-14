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

export async function agenticCommit(
  config: AgentConfig,
  llmConfig: LLMConfig
): Promise<void> {
  ensureGitRepository();

  // 1) Sense
  const status = getStatusSummary();
  const repo = getRepoName();
  const branch = getBranchName(status);

  // If including unstaged, we need to ensure we can stage files selectively
  // For file-level grouping, we'll work with what's already staged + optionally unstaged
  // Collect hunks (staged + optionally unstaged)
  let hunks = collectHunks(config.includeUnstaged);

  if (hunks.length === 0) {
    console.log("No changes to process.");
    return;
  }

  // If including unstaged, we need to stage them first for file-level grouping
  if (config.includeUnstaged) {
    // For file-level grouping, we'll stage files as needed
    // For now, collect all hunks but don't auto-stage everything
  }

  // 2) Think / Plan
  console.log(`Analyzing ${hunks.length} change(s) across ${new Set(hunks.map(h => h.file)).size} file(s)...`);

  let plan: GroupPlan[];
  try {
    plan = await requestGroupPlan(llmConfig, repo, branch, status, hunks);
  } catch (error) {
    console.error(`Failed to plan groups: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (plan.length === 0) {
    console.log("No logical groups identified.");
    return;
  }

  // Apply filters
  if (config.onlyTypes && config.onlyTypes.length > 0) {
    plan = plan.filter((g) => config.onlyTypes!.includes(g.type));
  }

  if (config.maxGroups && plan.length > config.maxGroups) {
    console.warn(
      `Limiting groups from ${plan.length} to ${config.maxGroups}`
    );
    plan = plan.slice(0, config.maxGroups);
  }

  // Optional critique of the plan
  if (!config.noCritique) {
    plan = await critiqueAndRefinePlan(llmConfig, plan);
  }

  // 3) Report plan
  if (config.planOnly) {
    printPlan(plan);
    return;
  }

  // 4) Act per group
  const committed: GroupPlan[] = [];
  const skipped: GroupPlan[] = [];

  for (let i = 0; i < plan.length; i++) {
    const group = plan[i];
    console.log(`\n[${i + 1}/${plan.length}] ${formatGroupHeader(group)}`);

    const filesToStage = [...new Set(group.files || group.hunks.map((h) => h.file))];
    
    if (filesToStage.length === 0) {
      console.warn("  Skipping: no files to stage");
      skipped.push(group);
      continue;
    }

    // Stage changes for this group:
    // - Default (legacy): stage entire files
    // - Optional: stage by hunk patch (more precise splitting within a file)
    if (config.useHunkStaging) {
      // Ensure a clean staging area before applying patch
      clearStagingArea();
      const patch = buildPatchForGroup(group.hunks);
      const ok = applyPatchToIndex(patch);
      if (!ok) {
        // Fallback to file-level staging if patch apply fails (e.g., new files/renames)
        clearStagingArea();
        if (!stageFiles(filesToStage)) {
          console.error("  Failed to stage files (fallback)");
          skipped.push(group);
          continue;
        }
      }
    } else {
      // For MVP, use file-level staging (stage entire files per group)
      if (!stageFiles(filesToStage)) {
        console.error("  Failed to stage files");
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


