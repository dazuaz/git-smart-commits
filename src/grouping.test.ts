import { describe, expect, test } from "bun:test";
import type { Hunk } from "./types.js";
import { summarizeHunks } from "./grouping.js";

function makeLargeHunk(file: string, hunkIndex: number): Hunk {
  const changedLines = Array.from({ length: 30 }, (_, i) => {
    const suffix = `${file}-${i}`.padEnd(140, "x");
    return `+export const value${i} = "${suffix}";`;
  });

  return {
    file,
    hunkIndex,
    startLine: 1,
    linesAdded: changedLines.length,
    linesRemoved: 0,
    patch: ["@@ -0,0 +1,30 @@", ...changedLines].join("\n"),
  };
}

describe("summarizeHunks", () => {
  test("includes later chunks instead of silently returning only the first", () => {
    const summary = summarizeHunks(
      [
        makeLargeHunk("src/first.ts", 1),
        makeLargeHunk("src/second.ts", 1),
      ],
      12_000,
    );

    expect(summary).toContain("Chunk c1:");
    expect(summary).toContain("Chunk c2:");
    expect(summary).toContain("File: src/first.ts");
    expect(summary).toContain("File: src/second.ts");
  });
});
