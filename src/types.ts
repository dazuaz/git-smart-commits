export const CONVENTIONAL_TYPES = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
] as const;

export type ConventionalType = (typeof CONVENTIONAL_TYPES)[number];

export type Hunk = {
  file: string;
  patch: string;
  linesAdded: number;
  linesRemoved: number;
  hunkIndex: number; // Index within the file's hunks
  startLine: number; // Starting line number in original file
  isNewFile?: boolean;
  isDeletedFile?: boolean;
  isRename?: boolean;
};

export type GroupPlan = {
  id: string;
  type: ConventionalType;
  additionalTypes?: ConventionalType[]; // For commits with multiple change types
  scope?: string;
  title: string; // <60 chars
  body?: string; // wrapped at 72 cols
  rationale: string;
  files: string[];
  hunks: Hunk[];
};

export type AgentConfig = {
  planOnly: boolean; // Print the proposed plan, do nothing
  dryRun: boolean; // Show what would be committed without committing
  strategy?: "squash" | "split"; // squash groups into 1 commit or create 1..N commits
  interactive?: boolean; // Prompt before including/committing changes
};

export type LLMConfig = {
  apiKey: string;
  model: string;
  temperature: number;
  baseUrl: string;
};

export type CritiqueResult = {
  ok: boolean;
  suggestedMessage?: string;
  reasons: string[];
};

export type LeakageCheck = {
  hasLeak: boolean;
  message?: string;
};
