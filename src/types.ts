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
  auto: boolean; // No prompts
  confirm: boolean; // Ask before each commit
  planOnly: boolean; // Print plan, do nothing
  includeUnstaged: boolean; // Include unstaged changes
  maxGroups?: number;
  minHunkSize?: number;
  onlyTypes?: ConventionalType[];
  noCritique: boolean; // Skip critique step
  dryRun: boolean; // Don't actually commit
  messageOnly: boolean; // Just print messages
  useHunkStaging?: boolean; // Stage by hunk patch instead of whole files
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

