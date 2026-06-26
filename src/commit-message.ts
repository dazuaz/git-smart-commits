import { CONVENTIONAL_TYPES } from "./types.js";

export const COMMIT_TITLE_MAX_LENGTH = 60;

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

  if (title.length > COMMIT_TITLE_MAX_LENGTH) {
    reasons.push(`title must be ${COMMIT_TITLE_MAX_LENGTH} characters or fewer`);
  }

  if (/[.!?]$/.test(title)) {
    reasons.push("title must not end with punctuation");
  }

  return { ok: reasons.length === 0, reasons };
}

export function normalizeCommitTitle(title: string): string {
  const compact = title.trim().replace(/\s+/g, " ");
  const withoutTrailingPunctuation = stripTrailingTitlePunctuation(compact);

  if (withoutTrailingPunctuation.length <= COMMIT_TITLE_MAX_LENGTH) {
    return withoutTrailingPunctuation;
  }

  const hardCut = withoutTrailingPunctuation
    .slice(0, COMMIT_TITLE_MAX_LENGTH)
    .trimEnd();
  const lastSpace = hardCut.lastIndexOf(" ");
  const wordCut =
    lastSpace >= Math.floor(COMMIT_TITLE_MAX_LENGTH * 0.7)
      ? hardCut.slice(0, lastSpace)
      : hardCut;

  return stripTrailingTitlePunctuation(wordCut);
}

export function repairConventionalCommitMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return trimmed;
  }

  const lines = trimmed.split(/\r?\n/);
  const header = lines[0] ?? "";
  const match = header.match(/^([a-z]+)(\([a-z0-9._/-]+\))?: (.+)$/);
  if (!match) {
    return trimmed;
  }

  const [, type, scope = "", title] = match;
  lines[0] = `${type}${scope}: ${normalizeCommitTitle(title)}`;
  return lines.join("\n").trim();
}

function stripTrailingTitlePunctuation(title: string): string {
  return title.replace(/[\s,;:._!?-]+$/g, "");
}
