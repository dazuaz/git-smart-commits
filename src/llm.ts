import type {
  Hunk,
  GroupPlan,
  LLMConfig,
  CritiqueResult,
  LeakageCheck,
  ConventionalType,
} from "./types.js";
import { CONVENTIONAL_TYPES } from "./types.js";
import { summarizeHunks } from "./grouping.js";

export async function requestGroupPlan(
  config: LLMConfig,
  repo: string,
  branch: string,
  status: string,
  hunks: Hunk[]
): Promise<GroupPlan[]> {
  const typeList = CONVENTIONAL_TYPES.join("|");

  // Summarize hunks to stay within token budget
  const hunkSummary = summarizeHunks(hunks, 12000);

  const prompt = `Repository: ${repo}
Branch: ${branch}
Status:
${status}

Rules:
- Types: ${typeList}
- Aim for single-purpose commits.
- May create 1..N groups. Merge tiny trivial hunks into nearest logical group.
- Keep the first line under 60 chars, imperative, lower case, no trailing punctuation.
- Include scope only if clarifying.
- Provide a rationale per group.
- Return JSON only, matching this schema:

{
  "groups": [
    {
      "id": "g1",
      "type": "feat|fix|...",
      "scope": "optional-scope",
      "title": "short summary",
      "body": "optional body, wrap ~72 cols",
      "files": ["path/a.ts", "path/b.test.ts"],
      "hunks": [{"file":"path/a.ts","hunkIndex":3}, ...]
    }
  ]
}

Diff hunks:
${hunkSummary}`;

  const systemPrompt = `You are a code change planner. Your task is to split a set of diffs into logically coherent commit groups that follow Conventional Commits. Prefer small, single-purpose groups. Return strict JSON only.`;

  const response = await fetchLLM(config, systemPrompt, prompt);

  try {
    // Try to extract JSON from response (handle markdown code blocks)
    let jsonStr = response.trim();
    if (jsonStr.includes("```")) {
      const match = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (match) {
        jsonStr = match[1];
      }
    }

    const parsed = JSON.parse(jsonStr) as { groups?: GroupPlan[] };
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
          if (typeof hunkRef === "object" && hunkRef.file && typeof hunkRef.hunkIndex === "number") {
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
      const files = group.files && Array.isArray(group.files) 
        ? group.files 
        : [...new Set(mappedHunks.map(h => h.file))];

      mappedGroups.push({
        ...group,
        type: validateType(group.type),
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
    const response = await fetchLLM(config, systemPrompt, prompt);
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
    const response = await fetchLLM(config, systemPrompt, prompt);
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
  userPrompt: string
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // 2 minutes for planning

  try {
    const endpoint = config.baseUrl.endsWith("/")
      ? `${config.baseUrl}v1/chat/completions`
      : `${config.baseUrl}/v1/chat/completions`;

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
      throw new Error(
        `LLM API request failed (${response.status}): ${text}`
      );
    }

    const json = (await response.json()) as {
      choices: Array<{ message?: { content?: string } }>;
    };

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LLM API returned no content.");
    }

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

