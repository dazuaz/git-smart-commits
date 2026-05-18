import { describe, expect, test } from "bun:test";
import { collectHunksFromDiff } from "./git.js";

describe("collectHunksFromDiff", () => {
  test("parses hunks and file metadata from a unified diff", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 80%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "diff --git a/src/created.ts b/src/created.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/created.ts",
      "@@ -0,0 +1 @@",
      "+export const created = true;",
    ].join("\n");

    const hunks = collectHunksFromDiff(diff);

    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({
      file: "src/new.ts",
      hunkIndex: 1,
      linesAdded: 1,
      linesRemoved: 1,
      isRename: true,
    });
    expect(hunks[1]).toMatchObject({
      file: "src/created.ts",
      hunkIndex: 1,
      linesAdded: 1,
      linesRemoved: 0,
      isNewFile: true,
    });
  });
});
