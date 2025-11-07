import type { Hunk, GroupPlan, ConventionalType } from "./types.js";

export function applyHeuristics(hunks: Hunk[]): Map<string, Hunk[]> {
  const groups = new Map<string, Hunk[]>();

  for (const hunk of hunks) {
    const file = hunk.file;
    let groupKey = "";

    // Group by top-level directory
    const parts = file.split("/");
    if (parts.length > 1) {
      const topDir = parts[0];
      // Common patterns
      if (topDir === "src" || topDir === "lib" || topDir === "app" || topDir === "apps") {
        if (parts.length > 2) {
          groupKey = `${topDir}/${parts[1]}`;
        } else {
          groupKey = topDir;
        }
      } else if (topDir === "packages" || topDir === "packages") {
        if (parts.length > 1) {
          groupKey = parts.slice(0, 2).join("/");
        } else {
          groupKey = topDir;
        }
      } else {
        groupKey = topDir;
      }
    } else {
      groupKey = "root";
    }

    // Separate by file type
    if (file.endsWith(".test.ts") || file.endsWith(".test.js") || file.endsWith(".spec.ts") || file.endsWith(".spec.js")) {
      groupKey = `test:${groupKey}`;
    } else if (file.endsWith(".md") || file.endsWith(".txt") || file.endsWith(".rst")) {
      groupKey = `docs:${groupKey}`;
    } else if (file === "package.json" || file === "package-lock.json" || file === "yarn.lock" || file === "pnpm-lock.yaml") {
      groupKey = "deps";
    } else if (file.includes("lock") || file.includes("vendor") || file.includes("generated")) {
      groupKey = "generated";
    }

    const existing = groups.get(groupKey) || [];
    existing.push(hunk);
    groups.set(groupKey, existing);
  }

  return groups;
}

export function summarizeHunks(hunks: Hunk[], maxLength: number = 8000): string {
  if (hunks.length === 0) {
    return "";
  }

  // Group by file
  const byFile = new Map<string, Hunk[]>();
  for (const hunk of hunks) {
    const existing = byFile.get(hunk.file) || [];
    existing.push(hunk);
    byFile.set(hunk.file, existing);
  }

  const summaries: string[] = [];
  let totalLength = 0;

  for (const [file, fileHunks] of byFile.entries()) {
    const fileSummary: string[] = [];
    fileSummary.push(`\nFile: ${file}`);

    for (const hunk of fileHunks) {
      const hunkLines = hunk.patch.split("\n").slice(0, 20); // First 20 lines of hunk
      const hunkPreview = hunkLines.join("\n");
      fileSummary.push(`  Hunk ${hunk.hunkIndex} (${hunk.linesAdded}+ ${hunk.linesRemoved}-):`);
      fileSummary.push(hunkPreview);
      if (hunk.patch.split("\n").length > 20) {
        fileSummary.push(`  ... (${hunk.patch.split("\n").length - 20} more lines)`);
      }
    }

    const fileSummaryStr = fileSummary.join("\n");
    if (totalLength + fileSummaryStr.length > maxLength) {
      summaries.push(`\n... (${byFile.size - summaries.length} more files)`);
      break;
    }

    summaries.push(fileSummaryStr);
    totalLength += fileSummaryStr.length;
  }

  return summaries.join("\n");
}

export function mergeTinyGroups(
  groups: GroupPlan[],
  minSize: number = 3
): GroupPlan[] {
  if (minSize <= 0) {
    return groups;
  }

  const merged: GroupPlan[] = [];
  const tiny: GroupPlan[] = [];

  for (const group of groups) {
    const totalHunks = group.hunks.length;
    if (totalHunks < minSize) {
      tiny.push(group);
    } else {
      merged.push(group);
    }
  }

  // Try to merge tiny groups into nearest logical neighbor
  for (const tinyGroup of tiny) {
    let merged_ = false;

    // Find a group with the same type
    for (const target of merged) {
      if (target.type === tinyGroup.type) {
        // Merge
        target.files.push(...tinyGroup.files);
        target.hunks.push(...tinyGroup.hunks);
        target.files = [...new Set(target.files)]; // Dedupe
        merged_ = true;
        break;
      }
    }

    // If no match by type, find by scope
    if (!merged_) {
      for (const target of merged) {
        if (target.scope && tinyGroup.scope && target.scope === tinyGroup.scope) {
          target.files.push(...tinyGroup.files);
          target.hunks.push(...tinyGroup.hunks);
          target.files = [...new Set(target.files)];
          merged_ = true;
          break;
        }
      }
    }

    // If still no match, merge into first group of same type or create new
    if (!merged_) {
      if (merged.length > 0) {
        merged[0].files.push(...tinyGroup.files);
        merged[0].hunks.push(...tinyGroup.hunks);
        merged[0].files = [...new Set(merged[0].files)];
      } else {
        merged.push(tinyGroup);
      }
    }
  }

  return merged;
}

export function inferTypeFromFile(file: string): ConventionalType {
  if (file.endsWith(".test.ts") || file.endsWith(".test.js") || file.endsWith(".spec.ts") || file.endsWith(".spec.js")) {
    return "test";
  }
  if (file.endsWith(".md") || file.endsWith(".txt") || file.endsWith(".rst")) {
    return "docs";
  }
  if (file === "package.json" || file === "package-lock.json" || file === "yarn.lock" || file === "pnpm-lock.yaml") {
    return "chore";
  }
  if (file.includes(".config.") || file.includes("Dockerfile") || file.includes(".github/workflows")) {
    return "ci";
  }
  return "chore";
}

export function inferScopeFromFile(file: string): string | undefined {
  const parts = file.split("/");
  if (parts.length > 1) {
    // Try to extract scope from directory structure
    if (parts[0] === "src" || parts[0] === "lib") {
      if (parts.length > 1) {
        return parts[1];
      }
    } else if (parts[0] === "packages" && parts.length > 1) {
      return parts[1];
    } else if (parts[0] === "apps" && parts.length > 1) {
      return parts[1];
    }
  }
  return undefined;
}

