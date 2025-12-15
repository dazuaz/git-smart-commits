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

export type PlanningChunk = {
  id: string;
  summary: string;
  files: string[];
  hunkRefs: Array<{ file: string; hunkIndex: number }>;
};

type BuildPlanningChunksOptions = {
  maxChunkChars: number;
  maxTotalChars?: number;
  perHunkMaxChangedLines?: number;
  perHunkMaxHeaderLines?: number;
  perLineMaxChars?: number;
};

function clampLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  return line.slice(0, Math.max(0, maxChars - 1)) + "…";
}

function pickChangedLines(
  changed: string[],
  maxLines: number
): { picked: string[]; omittedCount: number } {
  if (maxLines <= 0) return { picked: [], omittedCount: changed.length };
  if (changed.length <= maxLines) return { picked: changed, omittedCount: 0 };

  const headCount = Math.ceil(maxLines / 2);
  const tailCount = Math.floor(maxLines / 2);

  const picked = [...changed.slice(0, headCount), ...changed.slice(-tailCount)];

  // Deduplicate while preserving order (head/tail overlap for small arrays)
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const l of picked) {
    if (!seen.has(l)) {
      seen.add(l);
      uniq.push(l);
    }
  }

  return { picked: uniq, omittedCount: Math.max(0, changed.length - uniq.length) };
}

function extractSignalLines(lines: string[]): string[] {
  const signal: string[] = [];
  const re =
    /(export\s+|import\s+|from\s+["']|class\s+|interface\s+|type\s+|function\s+|async\s+function|const\s+\w+\s*=\s*\(|def\s+|enum\s+|schema|route|endpoint|controller|handler|middleware|migration|sql|graphql)/i;
  for (const l of lines) {
    const trimmed = l.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("+") || trimmed.startsWith("-")) {
      if (re.test(trimmed)) {
        signal.push(trimmed);
      }
    }
  }
  return signal;
}

export function formatHunkForPlanning(
  hunk: Hunk,
  opts?: BuildPlanningChunksOptions
): string {
  const perLineMaxChars = opts?.perLineMaxChars ?? 220;
  const perHunkMaxChangedLines = opts?.perHunkMaxChangedLines ?? 28;
  const perHunkMaxHeaderLines = opts?.perHunkMaxHeaderLines ?? 2;

  const rawLines = hunk.patch.split("\n");
  const headerLines = rawLines
    .filter((l) => l.startsWith("@@"))
    .slice(0, perHunkMaxHeaderLines);

  const changedLinesAll = rawLines.filter((l) => {
    if (l.startsWith("+++ ") || l.startsWith("--- ")) return false;
    return (l.startsWith("+") && !l.startsWith("++")) || (l.startsWith("-") && !l.startsWith("--"));
  });

  const signal = extractSignalLines(changedLinesAll).slice(0, 6);
  const { picked, omittedCount } = pickChangedLines(changedLinesAll, perHunkMaxChangedLines);

  const lines: string[] = [];
  lines.push(`  Hunk ${hunk.hunkIndex} (@${hunk.startLine}, ${hunk.linesAdded}+ ${hunk.linesRemoved}-):`);
  for (const hl of headerLines) lines.push(`    ${clampLine(hl, perLineMaxChars)}`);
  if (signal.length) {
    lines.push(`    Signals:`);
    for (const s of signal) lines.push(`      ${clampLine(s, perLineMaxChars)}`);
  }
  if (picked.length) {
    lines.push(`    Changed:`);
    for (const c of picked) lines.push(`      ${clampLine(c, perLineMaxChars)}`);
  }
  if (omittedCount > 0) {
    lines.push(`    (omitted ${omittedCount} changed lines)`);
  }
  return lines.join("\n");
}

export function buildPlanningChunks(
  hunks: Hunk[],
  opts: BuildPlanningChunksOptions
): PlanningChunk[] {
  const maxChunkChars = Math.max(2000, opts.maxChunkChars);
  const maxTotalChars = opts.maxTotalChars;

  // Group hunks by file to keep locality, then sort files for stability.
  const byFile = new Map<string, Hunk[]>();
  for (const h of hunks) {
    const existing = byFile.get(h.file) ?? [];
    existing.push(h);
    byFile.set(h.file, existing);
  }

  const files = [...byFile.keys()].sort();

  const chunks: PlanningChunk[] = [];
  let current: PlanningChunk = { id: `c${chunks.length + 1}`, summary: "", files: [], hunkRefs: [] };
  let totalChars = 0;

  const pushCurrent = () => {
    if (!current.summary.trim()) return;
    chunks.push(current);
    current = { id: `c${chunks.length + 1}`, summary: "", files: [], hunkRefs: [] };
  };

  const append = (text: string) => {
    current.summary += current.summary ? `\n${text}` : text;
  };

  for (const file of files) {
    const fileHunks = (byFile.get(file) ?? []).slice().sort((a, b) => a.hunkIndex - b.hunkIndex);

    const fileBlockLines: string[] = [];
    fileBlockLines.push(`File: ${file} (${fileHunks.length} hunk(s))`);
    for (const hunk of fileHunks) {
      fileBlockLines.push(formatHunkForPlanning(hunk, opts));
    }
    const fileBlock = fileBlockLines.join("\n");

    const projectedLen = (current.summary ? current.summary.length + 1 : 0) + fileBlock.length;
    if (current.summary && projectedLen > maxChunkChars) {
      pushCurrent();
    }

    // If a single file block is gigantic, hard-truncate it with a marker.
    let blockToAdd = fileBlock;
    if (blockToAdd.length > maxChunkChars) {
      blockToAdd =
        fileBlock.slice(0, Math.max(0, maxChunkChars - 120)) +
        `\n(truncated: file block exceeded chunk budget)\n`;
    }

    append(blockToAdd);
    current.files.push(file);
    for (const h of fileHunks) current.hunkRefs.push({ file: h.file, hunkIndex: h.hunkIndex });

    totalChars += blockToAdd.length;
    if (maxTotalChars && totalChars > maxTotalChars) {
      append(`\n(truncated: overall planning context exceeded maxTotalChars=${maxTotalChars})`);
      break;
    }
  }

  pushCurrent();
  return chunks;
}

export function summarizeHunks(hunks: Hunk[], maxLength: number = 8000): string {
  if (hunks.length === 0) {
    return "";
  }

  // New approach: reuse the planning formatter and chunk builder for a stable,
  // information-dense summary (still bounded by maxLength).
  const chunks = buildPlanningChunks(hunks, {
    maxChunkChars: maxLength,
    maxTotalChars: maxLength,
    perHunkMaxChangedLines: 24,
    perHunkMaxHeaderLines: 2,
    perLineMaxChars: 200,
  });

  if (chunks.length === 0) return "";
  return chunks[0].summary;
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
