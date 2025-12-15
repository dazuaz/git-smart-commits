import type { Hunk } from "./types.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
};

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

export function ensureGitRepository() {
  const result = exec(["git", "rev-parse", "--is-inside-work-tree"]);
  if (result.code !== 0 || result.stdout.trim() !== "true") {
    throw new Error("This command must be run inside a Git repository.");
  }
}

export function getStatusSummary(): string {
  const result = exec(["git", "status", "-sb"]);
  if (result.code !== 0) {
    throw new Error(`Failed to read git status: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function getBranchName(status?: string): string {
  if (status) {
    const firstLine = status.split("\n")[0]?.trim();
    if (firstLine?.startsWith("##")) {
      let branchHint = firstLine.slice(2).trim();
      if (branchHint.startsWith("No commits yet on ")) {
        branchHint = branchHint.replace("No commits yet on ", "").trim();
      }
      if (branchHint.includes("...")) {
        branchHint = branchHint.split("...")[0]?.trim() ?? branchHint;
      }
      if (branchHint === "HEAD (no branch)") {
        return "detached";
      }
      if (branchHint) {
        return branchHint;
      }
    }
  }

  const commands: string[][] = [
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    ["git", "branch", "--show-current"],
  ];

  for (const cmd of commands) {
    const result = exec(cmd);
    const name = result.stdout.trim();
    if (result.code === 0 && name) {
      return name;
    }
  }

  return "detached";
}

export function getRepoName(): string {
  const result = exec(["git", "rev-parse", "--show-toplevel"]);
  if (result.code !== 0) {
    throw new Error(`Failed to read repository name: ${result.stderr.trim()}`);
  }

  const path = result.stdout.trim();
  const segments = path.split("/");
  return segments[segments.length - 1] || path;
}

export function getStagedDiff(): string {
  const result = exec(["git", "diff", "--cached", "-U0"]);
  if (result.code !== 0) {
    throw new Error(`Failed to read staged diff: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function getUnstagedDiff(): string {
  const result = exec(["git", "diff", "-U0"]);
  if (result.code !== 0) {
    throw new Error(`Failed to read unstaged diff: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function getStagedPatch(): string {
  const result = exec(["git", "diff", "--cached"]);
  if (result.code !== 0) {
    throw new Error(`Failed to read staged patch: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function restoreStagedPatch(patch: string): boolean {
  // Best-effort restore of the index to a prior staged state.
  if (!clearStagingArea()) {
    return false;
  }

  if (!patch.trim()) {
    return true;
  }

  const proc = Bun.spawnSync({
    cmd: ["git", "apply", "--cached", "-"],
    stdin: encoder.encode(patch),
    stdout: "pipe",
    stderr: "pipe",
  });

  return (proc.exitCode ?? 1) === 0;
}

export function listUntrackedFiles(): string[] {
  const result = exec(["git", "ls-files", "--others", "--exclude-standard"]);
  if (result.code !== 0) {
    throw new Error(`Failed to list untracked files: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function intentToAddFiles(files: string[]): boolean {
  if (files.length === 0) {
    return true;
  }
  const result = exec(["git", "add", "-N", "--", ...files]);
  return result.code === 0;
}

export function collectHunksFromDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  if (!diff.trim()) {
    return hunks;
  }

  const lines = diff.split("\n");
  let currentFile = "";
  let currentHunk: string[] = [];
  let hunkIndex = 0;
  let startLine = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  let isNewFile = false;
  let isDeletedFile = false;
  let isRename = false;

  const pushCurrentHunk = () => {
    if (currentHunk.length === 0 || !currentFile) {
      return;
    }
    hunks.push({
      file: currentFile,
      patch: currentHunk.join("\n"),
      linesAdded,
      linesRemoved,
      hunkIndex,
      startLine,
      isNewFile: isNewFile || undefined,
      isDeletedFile: isDeletedFile || undefined,
      isRename: isRename || undefined,
    });
    currentHunk = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header: diff --git a/path b/path
    if (line.startsWith("diff --git")) {
      pushCurrentHunk();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match) {
        currentFile = match[2];
        hunkIndex = 0;
        isNewFile = false;
        isDeletedFile = false;
        isRename = false;
      } else {
        currentFile = "";
      }
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith("new file mode")) {
      isNewFile = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      isDeletedFile = true;
      continue;
    }
    if (line.startsWith("rename from") || line.startsWith("rename to")) {
      isRename = true;
      continue;
    }

    // Hunk header: @@ -start,count +start,count @@
    if (line.startsWith("@@")) {
      pushCurrentHunk();

      const match = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
      );
      if (!match) {
        continue;
      }

      startLine = parseInt(match[3] || "0", 10);
      linesAdded = 0;
      linesRemoved = 0;
      hunkIndex++;
      currentHunk = [line];
      continue;
    }

    // Skip non-hunk metadata and file markers.
    if (
      currentHunk.length === 0 &&
      (line.startsWith("index ") ||
        line.startsWith("---") ||
        line.startsWith("+++"))
    ) {
      continue;
    }

    if (currentHunk.length > 0) {
      currentHunk.push(line);
      if (line.startsWith("+") && !line.startsWith("+++")) {
        linesAdded++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        linesRemoved++;
      }
    }
  }

  pushCurrentHunk();

  return hunks;
}

export function buildPatchForGroup(hunks: Hunk[]): string {
  if (hunks.length === 0) {
    return "";
  }

  // Group hunks by file
  const hunksByFile = new Map<string, Hunk[]>();
  for (const hunk of hunks) {
    const existing = hunksByFile.get(hunk.file) || [];
    existing.push(hunk);
    hunksByFile.set(hunk.file, existing);
  }

  const patches: string[] = [];

  for (const [file, fileHunks] of hunksByFile.entries()) {
    // Build file header
    patches.push(`diff --git a/${file} b/${file}`);
    patches.push(`--- a/${file}`);
    patches.push(`+++ b/${file}`);

    // Add all hunks for this file
    for (const hunk of fileHunks.sort((a, b) => a.hunkIndex - b.hunkIndex)) {
      patches.push(hunk.patch);
    }
  }

  return patches.join("\n") + "\n";
}

export function applyPatchToIndex(patch: string): boolean {
  if (!patch.trim()) {
    return true;
  }

  const proc = Bun.spawnSync({
    cmd: ["git", "apply", "--cached", "--unidiff-zero", "--allow-empty", "-"],
    stdin: encoder.encode(patch.endsWith("\n") ? patch : `${patch}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });

  const code = proc.exitCode ?? 1;
  if (code !== 0) {
    const stderr = decoder.decode(proc.stderr ?? new Uint8Array());
    console.error(`Failed to apply patch: ${stderr.trim()}`);
    return false;
  }

  return true;
}

export function unstagePatch(patch: string): boolean {
  if (!patch.trim()) {
    return true;
  }

  // Reverse the patch and apply it to unstage
  const reversedPatch = patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return "-" + line.slice(1);
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        return "+" + line.slice(1);
      }
      return line;
    })
    .join("\n");

  // Unstage by resetting the specific files
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      files.add(match[2]);
    }
  }

  if (files.size > 0) {
    const result = exec(["git", "reset", "HEAD", "--", ...Array.from(files)]);
    return result.code === 0;
  }

  return true;
}

export function getDiffSummary(): string {
  const staged = getStagedDiff();
  const unstaged = getUnstagedDiff();
  return `Staged:\n${staged || "(none)"}\n\nUnstaged:\n${unstaged || "(none)"}`;
}

export function commitWithMessage(message: string): boolean {
  const normalized = message.endsWith("\n") ? message : `${message}\n`;

  const commit = Bun.spawnSync({
    cmd: ["git", "commit", "-F", "-"],
    stdin: encoder.encode(normalized),
    stdout: "pipe",
    stderr: "pipe",
  });

  if (commit.exitCode !== 0) {
    const stderr = decoder.decode(commit.stderr ?? new Uint8Array());
    console.error(`git commit failed: ${stderr.trim()}`);
    return false;
  }

  return true;
}

export function stageFiles(files: string[]): boolean {
  if (files.length === 0) {
    return true;
  }

  const result = exec(["git", "add", "-A", "--", ...files]);
  return result.code === 0;
}

export function stageAllChanges(): boolean {
  const result = exec(["git", "add", "-A"]);
  return result.code === 0;
}

export function unstageFiles(files: string[]): boolean {
  if (files.length === 0) {
    return true;
  }

  const result = exec(["git", "reset", "HEAD", "--", ...files]);
  return result.code === 0;
}

export function clearStagingArea(): boolean {
  const result = exec(["git", "reset", "HEAD"]);
  return result.code === 0;
}
