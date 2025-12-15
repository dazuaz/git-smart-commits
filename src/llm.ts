import type {
  Hunk,
  GroupPlan,
  LLMConfig,
  CritiqueResult,
  LeakageCheck,
  ConventionalType,
} from "./types.js";
import { CONVENTIONAL_TYPES } from "./types.js";
import { summarizeHunks, buildPlanningChunks } from "./grouping.js";
import { debugLog } from "./debug.js";

export async function requestGroupPlan(
  config: LLMConfig,
  repo: string,
  branch: string,
  status: string,
  hunks: Hunk[]
): Promise<GroupPlan[]> {
  const typeList = CONVENTIONAL_TYPES.join("|");
  debugLog(
    `planning: repo=${repo} branch=${branch} hunks=${hunks.length} files=${new Set(hunks.map((h) => h.file)).size}`,
  );

  // Build chunked planning context for large commits.
  const maxChunks = 8;
  let chunkChars = 9_000;
  let planningChunks = buildPlanningChunks(hunks, {
    maxChunkChars: chunkChars,
    maxTotalChars: 45_000,
    perHunkMaxChangedLines: 16,
    perHunkMaxHeaderLines: 1,
    perLineMaxChars: 160,
  });

  while (planningChunks.length > maxChunks && chunkChars < 30_000) {
    chunkChars += 6_000;
    planningChunks = buildPlanningChunks(hunks, {
      maxChunkChars: chunkChars,
      maxTotalChars: 75_000,
      perHunkMaxChangedLines: 16,
      perHunkMaxHeaderLines: 1,
      perLineMaxChars: 160,
    });
  }
  debugLog(`planning: chunks=${planningChunks.length} chunkChars=${chunkChars}`);

  // Small enough: single-pass planning.
  if (planningChunks.length <= 1) {
    // Summarize hunks to stay within token budget
    const hunkSummary = summarizeHunks(hunks, 5_000);
    debugLog(`planning: single-pass hunkSummaryChars=${hunkSummary.length}`);

    const prompt = `Repository: ${repo}
Branch: ${branch}
    const filesCount = new Set(hunks.map((h) => h.file)).size;
    const groupGuidance =
      filesCount <= 10
        ? "Prefer 1 group unless there are clearly separate concerns; max 3 groups."
        : "Prefer small, single-purpose groups; avoid over-splitting.";

Status:
${status}

Rules:
- Types: ${typeList}
- ${groupGuidance}
- May create 1..N groups. Merge tiny trivial hunks into nearest logical group.
- Keep the first line under 60 chars, imperative, lower case, no trailing punctuation.
- Include scope only if clarifying.
- For groups with multiple significant change types, include "additionalTypes" (max 2).
  Only use additionalTypes when changes genuinely span multiple categories (e.g., feat + fix, refactor + perf).
- Keep "rationale" concise (<= 120 chars). Omit "body" unless it adds important context; if present, keep it <= 2 short lines.
- Return JSON only, matching this schema:

{
  "groups": [
    {
      "id": "g1",
      "type": "feat|fix|...",
      "additionalTypes": ["fix", "refactor"],
      "scope": "optional-scope",
      "title": "short summary",
      "body": "optional body, wrap ~72 cols",
      "files": ["path/a.ts", "path/b.test.ts"],
      "hunks": [{"file":"path/a.ts","hunkIndex":3}, ...]
      "rationale": "short why",
    }
  ]
}

Diff hunks:
${hunkSummary}`;

    const systemPrompt = `You are a code change planner. Your task is to split a set of diffs into logically coherent commit groups that follow Conventional Commits. Prefer small, single-purpose groups. Return strict JSON only.`;

    const response = await fetchLLM(config, systemPrompt, prompt, "plan(single-pass)");

    const groups = mapAndValidateGroups(response, hunks);
    return normalizePlanCoverage(groups, hunks);
  }

  // Multi-pass planning:
  // 1) Extract conservative candidates per chunk
  // 2) Merge/dedupe candidates into final GroupPlan list
  const candidateSchema = `{
  "candidates": [
    {
      "type": "feat|fix|...",
      "additionalTypes": ["fix", "refactor"],
      "scope": "optional-scope",
      "title": "short summary",
      "rationale": "why these changes belong together (<= 120 chars)",
      "files": ["path/a.ts", "path/b.test.ts"],
      "hunks": [{"file":"path/a.ts","hunkIndex":3}]
    }
  ],
  "notes": ["optional notes about missing context or uncertainty"]
}`;

  const perChunkSystem =
    `You are a code change analyst. Given a PARTIAL diff chunk, propose candidate commit groups that are internally coherent. ` +
    `Do not assume you see the whole change set; keep groups conservative and do not drop hunks. Return strict JSON only.`;

  const perChunkCandidates: Array<{
    chunkId: string;
    candidates: any[];
    notes?: string[];
  }> = [];

  for (const chunk of planningChunks) {
    debugLog(
      `planning: candidate chunk=${chunk.id} files=${chunk.files.length} summaryChars=${chunk.summary.length}`,
    );
    const perChunkPrompt = `Repository: ${repo}
Branch: ${branch}

You are seeing ONLY chunk ${chunk.id} of ${planningChunks.length}.
Rules:
- Types: ${typeList}
- Prefer small, single-purpose candidates.
- Candidates should reference hunks by {"file","hunkIndex"} whenever possible.
- It is OK to return an empty candidates array if the chunk is ambiguous.
- Return JSON only matching this schema:
${candidateSchema}

Diff chunk:
${chunk.summary}`;

    const resp = await fetchLLM(
      config,
      perChunkSystem,
      perChunkPrompt,
      `plan(candidates:${chunk.id})`,
    );
    const parsed = parseJSONFromLLM(resp) as { candidates?: any[]; notes?: string[] };
    perChunkCandidates.push({
      chunkId: chunk.id,
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    });
  }

  // Merge pass: ask the LLM to consolidate candidates into final groups.
  const allHunkRefs = hunks.map((h) => ({ file: h.file, hunkIndex: h.hunkIndex }));
  const mergeSystem =
    `You are a code change planner. Consolidate candidate commit groups from multiple partial chunks into a final coherent plan. ` +
    `Ensure every hunk is assigned to exactly one group. Return strict JSON only.`;

  const mergePrompt = `Repository: ${repo}
Branch: ${branch}
Status:
${status}

You have candidate groups extracted from ${planningChunks.length} diff chunks.
Now produce the FINAL plan in this exact JSON schema:
{
  "groups": [
    {
      "id": "g1",
      "type": "feat|fix|...",
      "additionalTypes": ["fix", "refactor"],
      "scope": "optional-scope",
      "title": "short summary",
      "body": "optional body, wrap ~72 cols",
      "rationale": "explain grouping",
      "files": ["path/a.ts", "path/b.test.ts"],
      "hunks": [{"file":"path/a.ts","hunkIndex":3}]
    }
  ]
}

Rules:
- Types: ${typeList}
- Prefer single-purpose commits when possible and avoid over-splitting.
- Assign EVERY hunk reference below to exactly one group.
- If uncertain, create a "chore" group titled "update misc changes" rather than dropping hunks.
- Keep titles under 60 chars, imperative, lower case, no trailing punctuation.
- additionalTypes max 2; only when truly spanning multiple categories.

All hunks (must be fully covered):
- Keep "rationale" concise (<= 120 chars). Omit "body" unless it adds important context; if present, keep it <= 2 short lines.
${JSON.stringify(allHunkRefs)}

Chunk candidates (may overlap, may be incomplete):
${JSON.stringify(perChunkCandidates)}`;

  const mergedResp = await fetchLLM(config, mergeSystem, mergePrompt, "plan(merge)");
  const groups = mapAndValidateGroups(mergedResp, hunks);
  return normalizePlanCoverage(groups, hunks);
}

export async function critiqueAndRefinePlan(
  config: LLMConfig,
  plan: GroupPlan[]
): Promise<GroupPlan[]> {
  // Simple validation for now - can be enhanced with LLM critique
  const refined: GroupPlan[] = [];

  for (const group of plan) {
    // Validate and fix common issues
    if (!group.title || group.title.length > 60) {
      group.title = group.title.slice(0, 57) + "...";
    }

    if (!group.type || !CONVENTIONAL_TYPES.includes(group.type)) {
      group.type = "chore";
    }

    refined.push(group);
  }

  return refined;
}

function parseJSONFromLLM(response: string): any {
  let jsonStr = response.trim();
  if (jsonStr.includes("```")) {
    const match = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (match) {
      jsonStr = match[1];
    }
  }
  return JSON.parse(jsonStr);
}

function mapAndValidateGroups(response: string, hunks: Hunk[]): GroupPlan[] {
  try {
    const parsed = parseJSONFromLLM(response) as { groups?: any[] };
    if (!parsed.groups || !Array.isArray(parsed.groups)) {
      throw new Error("Invalid response format: missing groups array");
    }

    // Map hunks by file and hunk index
    const hunksByFile = new Map<string, Map<number, Hunk>>();
    const allHunksByFile = new Map<string, Hunk[]>();
    for (const hunk of hunks) {
      if (!hunksByFile.has(hunk.file)) {
        hunksByFile.set(hunk.file, new Map());
        allHunksByFile.set(hunk.file, []);
      }
      hunksByFile.get(hunk.file)!.set(hunk.hunkIndex, hunk);
      allHunksByFile.get(hunk.file)!.push(hunk);
    }

    const mappedGroups: GroupPlan[] = [];
    for (const group of parsed.groups) {
      const mappedHunks: Hunk[] = [];

      // First try to match by explicit hunk references
      if (group.hunks && Array.isArray(group.hunks) && group.hunks.length > 0) {
        for (const hunkRef of group.hunks) {
          if (
            typeof hunkRef === "object" &&
            hunkRef.file &&
            typeof hunkRef.hunkIndex === "number"
          ) {
            const fileHunks = hunksByFile.get(hunkRef.file);
            if (fileHunks) {
              const hunk = fileHunks.get(hunkRef.hunkIndex);
              if (hunk) {
                mappedHunks.push(hunk);
              }
            }
          }
        }
      }

      // If no hunks matched by reference, match by files (file-level grouping)
      if (mappedHunks.length === 0 && group.files && Array.isArray(group.files)) {
        for (const file of group.files) {
          const fileHunks = allHunksByFile.get(file);
          if (fileHunks) {
            mappedHunks.push(...fileHunks);
          }
        }
      }

      // Ensure files list is populated
      const files =
        group.files && Array.isArray(group.files)
          ? group.files
          : [...new Set(mappedHunks.map((h) => h.file))];

      // Validate and limit additionalTypes
      const additionalTypes =
        group.additionalTypes && Array.isArray(group.additionalTypes)
          ? group.additionalTypes
              .map((t: string) => validateType(t))
              .filter((t: ConventionalType) => t !== group.type) // Remove duplicates of main type
              .slice(0, 2) // Max 2 additional types
          : undefined;

      mappedGroups.push({
        ...group,
        id: typeof group.id === "string" ? group.id : `g${mappedGroups.length + 1}`,
        type: validateType(group.type),
        additionalTypes: additionalTypes?.length ? additionalTypes : undefined,
        files,
        hunks: mappedHunks,
      });
    }

    return mappedGroups;
  } catch (error) {
    throw new Error(
      `Failed to parse LLM response as JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function normalizePlanCoverage(groups: GroupPlan[], hunks: Hunk[]): GroupPlan[] {
  const byRef = new Map<string, Hunk>();
  for (const h of hunks) {
    byRef.set(`${h.file}#${h.hunkIndex}`, h);
  }

  const assigned = new Set<string>();
  const normalized: GroupPlan[] = [];

  for (const g of groups) {
    const kept: Hunk[] = [];
    for (const h of g.hunks) {
      const key = `${h.file}#${h.hunkIndex}`;
      if (!assigned.has(key)) {
        assigned.add(key);
        kept.push(h);
      }
    }

    if (kept.length === 0) {
      continue;
    }

    const files = [...new Set([...(g.files ?? []), ...kept.map((h) => h.file)])];
    normalized.push({ ...g, files, hunks: kept });
  }

  const missing: Hunk[] = [];
  for (const h of hunks) {
    const key = `${h.file}#${h.hunkIndex}`;
    if (!assigned.has(key)) {
      missing.push(h);
    }
  }

  if (missing.length > 0) {
    normalized.push({
      id: `g${normalized.length + 1}`,
      type: "chore",
      title: "update misc changes",
      rationale: "catch-all group for changes not confidently classified",
      files: [...new Set(missing.map((h) => h.file))],
      hunks: missing,
    });
  }

  return normalized;
}

export async function checkLeakageLLM(
  config: LLMConfig,
  message: string,
  residualDiff: string
): Promise<LeakageCheck> {
  if (!residualDiff.trim() || residualDiff.includes("(none)")) {
    return { hasLeak: false };
  }

  const prompt = `Message:
${message}

Residual diff summary:
${residualDiff.slice(0, 4000)}

Does the residual diff contain changes that should have been included in the commit? Return JSON:
{"hasLeak": boolean, "message": "explanation if hasLeak is true"}`;

  const systemPrompt = `You are a commit QA assistant. Check if the residual diff contains changes that logically belong with the commit message.`;

  try {
    const response = await fetchLLM(config, systemPrompt, prompt, "qa(leakage)");
    let jsonStr = response.trim();
    if (jsonStr.includes("```")) {
      const match = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (match) {
        jsonStr = match[1];
      }
    }

    const parsed = JSON.parse(jsonStr) as LeakageCheck;
    return parsed;
  } catch {
    // If critique fails, assume no leakage
    return { hasLeak: false };
  }
}

export async function critiqueCommitMessage(
  config: LLMConfig,
  message: string,
  groupDiffSummary: string
): Promise<CritiqueResult> {
  const prompt = `Message:
${message}

Group diff summary:
${groupDiffSummary.slice(0, 4000)}

Return: {"ok": boolean, "suggestedMessage": "<string if any>", "reasons": ["..."] }`;

  const systemPrompt = `You are a commit QA assistant. Check that the message matches the grouped change. Suggest improvements or pass.`;

  try {
    const response = await fetchLLM(config, systemPrompt, prompt, "qa(message)");
    let jsonStr = response.trim();
    if (jsonStr.includes("```")) {
      const match = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (match) {
        jsonStr = match[1];
      }
    }

    const parsed = JSON.parse(jsonStr) as CritiqueResult;
    return parsed;
  } catch {
    return { ok: true, reasons: [] };
  }
}

async function fetchLLM(
  config: LLMConfig,
  systemPrompt: string,
  userPrompt: string,
  label: string = "llm"
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // 2 minutes for planning

  try {
    const endpoint = config.baseUrl.endsWith("/")
      ? `${config.baseUrl}v1/chat/completions`
      : `${config.baseUrl}/v1/chat/completions`;

    const startedAt = Date.now();
    debugLog(
      `${label}: request start endpoint=${endpoint} model=${config.model} userPromptChars=${userPrompt.length}`,
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: config.temperature,
        max_tokens: 2000, // More tokens for planning
        n: 1,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      debugLog(
        `${label}: request failed status=${response.status} elapsedMs=${Date.now() - startedAt} bodyChars=${text.length}`,
      );
      throw new Error(
        `LLM API request failed (${response.status}): ${text}`
      );
    }

    const json = (await response.json()) as {
      choices: Array<{ message?: { content?: string } }>;
    };

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      debugLog(
        `${label}: empty content elapsedMs=${Date.now() - startedAt}`,
      );
      throw new Error("LLM API returned no content.");
    }

    debugLog(
      `${label}: request ok elapsedMs=${Date.now() - startedAt} contentChars=${content.length}`,
    );
    return content.trim();
  } finally {
    clearTimeout(timeout);
  }
}

function validateType(type: string): ConventionalType {
  if (CONVENTIONAL_TYPES.includes(type as ConventionalType)) {
    return type as ConventionalType;
  }
  return "chore";
}
