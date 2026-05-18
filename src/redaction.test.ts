import { describe, expect, test } from "bun:test";
import { redactSensitiveText } from "./redaction.js";

describe("redactSensitiveText", () => {
  test("redacts common token shapes", () => {
    const line =
      '+const token = "ghp_abcdefghijklmnopqrstuvwxyzABCDE"; const key = "sk-abcdefghijklmnopqrstuvwxyz";';

    const redacted = redactSensitiveText(line);

    expect(redacted).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(redacted).toContain("[REDACTED_OPENAI_KEY]");
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyzABCDE");
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  test("redacts secret-like assignments", () => {
    const redacted = redactSensitiveText("+password=super-secret-value");

    expect(redacted).toBe("+password=[REDACTED]");
  });
});
