import { describe, expect, test } from "bun:test";
import { validateConventionalCommitMessage } from "./commit-message.js";

describe("validateConventionalCommitMessage", () => {
  test("accepts a valid Conventional Commit header", () => {
    const result = validateConventionalCommitMessage(
      "fix(cli): require explicit commit confirmation",
    );

    expect(result).toEqual({ ok: true, reasons: [] });
  });

  test("rejects invalid headers", () => {
    const result = validateConventionalCommitMessage("update the cli");

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(
      "header must match <type>(optional-scope): <title>",
    );
  });

  test("rejects unknown types and punctuated titles", () => {
    const result = validateConventionalCommitMessage(
      "change(cli): require explicit commit confirmation.",
    );

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(
      "type must be one of: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test",
    );
    expect(result.reasons).toContain("title must not end with punctuation");
  });
});
