import { describe, expect, test } from "bun:test";
import {
  normalizeCommitTitle,
  repairConventionalCommitMessage,
  validateConventionalCommitMessage,
} from "./commit-message.js";

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

  test("shortens overlong titles at a word boundary", () => {
    const title =
      "implement legacy hubspot encompass links import workflow with validation and tests";

    const normalized = normalizeCommitTitle(title);

    expect(normalized).toBe(
      "implement legacy hubspot encompass links import workflow",
    );
    expect(normalized.length).toBeLessThanOrEqual(60);
  });

  test("repairs overlong generated messages before validation", () => {
    const message = `feat(hubspot-encompass-links): implement legacy hubspot encompass links import workflow with validation and tests

- introduce legacy import flow, types, constants, and validation for hubspot encompass links
- add importLegacyLinkedDeals mutation scaffold and test updates`;

    const repaired = repairConventionalCommitMessage(message);

    expect(repaired.split("\n")[0]).toBe(
      "feat(hubspot-encompass-links): implement legacy hubspot encompass links import workflow",
    );
    expect(validateConventionalCommitMessage(repaired)).toEqual({
      ok: true,
      reasons: [],
    });
  });
});
