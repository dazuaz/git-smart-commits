import { CONVENTIONAL_TYPES } from "./types.js";

export type CommitMessageValidation = {
  ok: boolean;
  reasons: string[];
};

export function validateConventionalCommitMessage(
  message: string,
): CommitMessageValidation {
  const trimmed = message.trim();
  const reasons: string[] = [];

  if (!trimmed) {
    return { ok: false, reasons: ["message is empty"] };
  }

  const header = trimmed.split(/\r?\n/, 1)[0] ?? "";
  const match = header.match(/^([a-z]+)(?:\(([a-z0-9._/-]+)\))?: (.+)$/);

  if (!match) {
    reasons.push("header must match <type>(optional-scope): <title>");
    return { ok: false, reasons };
  }

  const [, type, , title] = match;
  if (!CONVENTIONAL_TYPES.includes(type as any)) {
    reasons.push(`type must be one of: ${CONVENTIONAL_TYPES.join(", ")}`);
  }

  if (!title.trim()) {
    reasons.push("title is empty");
  }

  if (title.length > 60) {
    reasons.push("title must be 60 characters or fewer");
  }

  if (/[.!?]$/.test(title)) {
    reasons.push("title must not end with punctuation");
  }

  return { ok: reasons.length === 0, reasons };
}
