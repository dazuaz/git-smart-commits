import type { AgentConfig, GroupPlan, Hunk, LLMConfig } from "./types.js";
import {
  applyPatchToIndex,
  buildPatchForGroup,
  clearStagingArea,
  collectHunksFromDiff,
  commitWithMessage,
  ensureGitRepository,
  getBranchName,
  getRepoName,
  getStagedDiff,
  getStagedPatch,
  getStatusSummary,
  getUnstagedDiff,
  intentToAddFiles,
  listUntrackedFiles,
  restoreStagedPatch,
  stageAllChanges,
  stageFiles,
} from "./git.js";
import { requestGroupPlan } from "./llm.js";
import { debugLog } from "./debug.js";

export async function smartCommit(
  config: AgentConfig,
  llmConfig: LLMConfig,
): Promise<void> {
  const interactive = config.interactive ?? false;
  const strategy = config.strategy ?? "squash";
  ensureGitRepository();

  const status = getStatusSummary();
  const repo = getRepoName();
  const branch = getBranchName(status);
  debugLog(`repo=${repo} branch=${branch}`);

  const initialStagedDiff = getStagedDiff();
  const initialUnstagedDiff = getUnstagedDiff();
  const initialUntracked = listUntrackedFiles();
  debugLog(
    `initial: stagedChars=${initialStagedDiff.length} unstagedChars=${initialUnstagedDiff.length} untracked=${initialUntracked.length}`,
  );

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
  const includeAll = hasStaged && hasUnstaged
    ? interactive
      ? await promptYesNo("Include unstaged/untracked changes too? (y/N): ", false)
      : false
    : !hasStaged;
  debugLog(`includeAll=${includeAll}`);

  const stagedSnapshot = getStagedPatch();
  let committedAny = false;

  try {
    // Normalize the index so we can stage precisely per group without depending
    // on whatever the user had staged previously.
    //
    // - Staged-only: we plan from the staged diff we already captured.
    // - All changes: we clear the index and plan from the working tree diff.
    const diffForPlanning = includeAll
      ? prepareAllChangesDiff()
      : initialStagedDiff;
    debugLog(`planningDiffChars=${diffForPlanning.length}`);

    const hunks = collectHunksFromDiff(diffForPlanning);
    if (hunks.length === 0) {
      console.log("No diff hunks detected. Nothing to commit.");
      return;
    }
    debugLog(
      `parsedHunks=${hunks.length} files=${new Set(hunks.map((h) => h.file)).size}`,
    );

    const plan = await requestGroupPlan(llmConfig, repo, branch, status, hunks);
    if (plan.length === 0) {
      console.log("No logical commit groups identified.");
      return;
    }
    debugLog(`planGroups=${plan.length}`);

    validatePlanForSharedFiles(plan);

    printPlan(plan);
    if (config.planOnly) {
      return;
    }

    if (interactive) {
      const proceed = await promptYesNo(
        `Proceed to ${config.dryRun ? "simulate" : "create"} ${strategy === "squash" ? 1 : plan.length} commit(s)? (y/N): `,
        false,
      );
      if (!proceed) {
        console.log("Aborted.");
        return;
      }
    }

    if (strategy === "squash") {
      const message = formatSquashedCommit(plan);
      console.log(`\nProposed squashed commit message:\n${message}\n`);

      if (includeAll) {
        // Plan was derived from working tree diff; stage everything for the single commit.
        if (!stageAllChanges()) {
          throw new Error("Failed to stage changes for squashed commit.");
        }
      }

      const stagedDiff = getStagedDiff();
      debugLog(`squash: stagedChars=${stagedDiff.length}`);
      if (!stagedDiff.trim()) {
        console.warn("No changes staged. Nothing to commit.");
        return;
      }

      if (config.dryRun) {
        console.log("  [DRY RUN] Would create 1 squashed commit");
        return;
      }

      const ok = commitWithMessage(message);
      if (ok) {
        committedAny = true;
        console.log(`Created 1 squashed commit.`);
      }
      return;
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
      debugLog(
        `group ${group.id}: files=${group.files.length} hunks=${group.hunks.length}`,
      );

      const message = formatConventionalCommit(group);
      console.log(`\nProposed commit message:\n${message}\n`);
      console.log(`Files: ${group.files.join(", ")}`);
      if (group.rationale) {
        console.log(`Rationale: ${group.rationale}`);
      }

      if (interactive) {
        const accepted = await promptYesNo("Commit? (y/N): ", false);
        if (!accepted) {
          console.log("  Skipped by user");
          skipped.push(group);
          continue;
        }
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
      debugLog(`group ${group.id}: stagedChars=${stagedDiff.length}`);
      if (!stagedDiff.trim()) {
        console.warn("  Skipping: no changes staged");
        clearStagingArea();
        skipped.push(group);
        continue;
      }

      if (config.dryRun) {
        console.log("  [DRY RUN] Would commit staged changes above");
        committed.push(group);
        clearStagingArea();
        continue;
      }

      const ok = commitWithMessage(message);
      clearStagingArea();

      if (ok) {
        committed.push(group);
        committedAny = true;
      } else {
        skipped.push(group);
      }
    }

    printSummary(committed, skipped);
  } finally {
    if (config.planOnly || config.dryRun || !committedAny) {
      debugLog("restoring staged index snapshot");
      restoreStagedPatch(stagedSnapshot);
    } else {
      clearStagingArea();
    }
  }
}

function prepareAllChangesDiff(): string {
  // We need a single, collision-free hunk index space per file. The simplest way
  // is to ensure the index is clean and only plan from the working tree diff.
  clearStagingArea();

  const untracked = listUntrackedFiles();
  if (untracked.length > 0) {
    // Make untracked files show up in `git diff` as new-file patches without
    // staging their contents yet.
    debugLog(`intent-to-add untracked files: count=${untracked.length}`);
    intentToAddFiles(untracked);
  }

  return getUnstagedDiff();
}

function countFilesAcrossGroups(plan: GroupPlan[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of plan) {
    for (const file of group.files) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return counts;
}

function validatePlanForSharedFiles(plan: GroupPlan[]): void {
  const counts = countFilesAcrossGroups(plan);
  const shared = new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([f]) => f),
  );

  if (shared.size === 0) {
    return;
  }

  const problems: string[] = [];

  for (const file of shared) {
    for (const group of plan) {
      if (!group.files.includes(file)) {
        continue;
      }
      const hasHunksForFile = group.hunks.some((h) => h.file === file);
      if (!hasHunksForFile) {
        problems.push(
          `Group ${group.id} includes shared file ${file} but has no hunks for it.`,
        );
      }
    }
  }

  // New/deleted/renamed files cannot be safely split across multiple commits via
  // patch staging; require them to appear in only one group.
  for (const group of plan) {
    const special = new Set(
      group.hunks
        .filter((h) => h.isNewFile || h.isDeletedFile || h.isRename)
        .map((h) => h.file),
    );
    for (const file of special) {
      if ((counts.get(file) ?? 0) > 1) {
        problems.push(
          `File ${file} looks like a new/deleted/renamed file but appears in multiple groups.`,
        );
      }
    }
  }

  if (problems.length > 0) {
    const msg =
      "The AI plan is not safely stageable:\n" +
      problems.map((p) => `- ${p}`).join("\n") +
      "\n\nRe-run to get a better plan, or stage/commit manually.";
    throw new Error(msg);
  }
}

function stageGroup(group: GroupPlan, sharedFiles: Set<string>): boolean {
  const sharedHunks = group.hunks.filter((h) => sharedFiles.has(h.file));
  const patchableSharedHunks = sharedHunks.filter(
    (h) => !h.isNewFile && !h.isDeletedFile && !h.isRename,
  );

  if (patchableSharedHunks.length > 0) {
    const patch = buildPatchForGroup(patchableSharedHunks);
    if (!applyPatchToIndex(patch)) {
      return false;
    }
  }

  // Stage non-shared files as full files (fast and robust for new/deleted files).
  const nonSharedFiles = group.files.filter((f) => !sharedFiles.has(f));
  if (nonSharedFiles.length > 0) {
    return stageFiles(nonSharedFiles);
  }

  return true;
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

  const bodyParts: string[] = [];
  if (group.body) {
    bodyParts.push(group.body);
  }
  if (group.additionalTypes?.length) {
    bodyParts.push(`Also includes: ${group.additionalTypes.join(", ")}`);
  }

  return bodyParts.length > 0 ? `${header}\n\n${bodyParts.join("\n\n")}` : header;
}

function formatSquashedCommit(plan: GroupPlan[]): string {
  if (plan.length === 0) {
    return "chore: smart commit";
  }
  if (plan.length === 1) {
    return formatConventionalCommit(plan[0]);
  }

  const primary = selectPrimaryGroup(plan);
  const scope = primary.scope ? `(${primary.scope})` : "";
  const header = `${primary.type}${scope}: ${primary.title}`;

  const bodyParts: string[] = [];
  if (primary.body) {
    bodyParts.push(primary.body);
  }

  bodyParts.push(
    "Includes:\n" +
      plan
        .filter((g) => g.id !== primary.id)
        .map((g) => {
          const line = `- ${formatGroupHeader(g)}`;
          return g.body ? `${line}\n  ${g.body.split("\n").join("\n  ")}` : line;
        })
        .join("\n"),
  );

  return `${header}\n\n${bodyParts.join("\n\n")}`;
}

function selectPrimaryGroup(plan: GroupPlan[]): GroupPlan {
  const typePriority: Record<string, number> = {
    feat: 100,
    fix: 90,
    perf: 80,
    refactor: 70,
    test: 60,
    docs: 50,
    ci: 40,
    build: 30,
    chore: 20,
    style: 10,
    revert: 0,
  };

  const scoreGroup = (g: GroupPlan) => {
    const typeScore = typePriority[g.type] ?? 25;
    const delta = g.hunks.reduce(
      (sum, h) => sum + (h.linesAdded ?? 0) + (h.linesRemoved ?? 0),
      0,
    );
    return typeScore * 1_000_000 + delta;
  };

  return plan.reduce((best, g) => (scoreGroup(g) > scoreGroup(best) ? g : best));
}

async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  process.stdout.write(question);

  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const handler = (char: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", handler);

      const normalized = char.trim().toLowerCase();
      if (!normalized) {
        resolve(defaultYes);
        return;
      }
      resolve(normalized === "y" || normalized === "yes");
    };

    stdin.once("data", handler);
  });
}

function printPlan(plan: GroupPlan[]): void {
  console.log("\n=== Commit Plan ===\n");
  for (let i = 0; i < plan.length; i++) {
    const group = plan[i];
    console.log(`${i + 1}. ${formatGroupHeader(group)}`);
    if (group.body) {
      console.log(`   ${group.body.split("\n").join("\n   ")}`);
    }
    console.log(`   Files: ${group.files.join(", ")}`);
    if (group.rationale) {
      console.log(`   Rationale: ${group.rationale}`);
    }
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
