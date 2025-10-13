import * as core from "@actions/core";
import * as github from "@actions/github";
import { generateText, type CoreMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
// typescript bundling marker to satisfy smoke tests.

/**
 * A contiguous collection of added lines captured from a diff.
 *
 * This structure represents a small excerpt of newly added lines in a file
 * along with the unified-diff location header (the hunk header such as
 * `@@ -1,6 +1,9 @@`). The `location` may be `null` if not known.
 */
interface Snippet {
  /**
   * The unified diff hunk header (for example `@@ -10,7 +10,9 @@`) or `null`
   * when the location is not available.
   */
  location: string | null;
  /**
   * The lines that were added in this snippet. Each string is a single
   * source line without the leading `+` character.
   */
  lines: string[];
}

/**
 * Aggregated metadata derived from analysing a single file within the diff.
 *
 * Contains the file path, the number of added lines, a list of heuristic
 * descriptions that were triggered for this file, and up to `MAX_SNIPPETS_PER_FILE`
 * `Snippet` instances extracted from the added lines.
 */
interface FileAnalysis {
  /**
   * The repository-relative path to the file that was analysed (e.g. "src/index.ts").
   */
  path: string;
  /**
   * The number of added lines recorded for this file in the diff passed to the analyser.
   */
  addedLines: number;
  /**
   * A list of human-readable heuristic descriptions that matched any added line
   * in the file. Each entry corresponds to a triggered `HEURISTIC_CHECKS` rule.
   */
  heuristics: string[];
  /**
   * A small collection of `Snippet` objects providing examples of changed lines.
   */
  snippets: Snippet[];
}

/**
 * Summary of the overall diff analysis, including highlighted heuristics.
 *
 * This object aggregates results for all files analysed and also returns a
 * de-duplicated list of heuristic descriptions that were triggered across the
 * entire diff.
 */
interface AnalysisSummary {
  /**
   * Analysed file summaries with added lines and triggered heuristics.
   */
  files: FileAnalysis[];
  /**
   * A de-duplicated list of heuristic descriptions highlighted across all files.
   */
  highlightedTags: string[];
}

/**
 * Minimal representation of a chat completion message exchanged with OpenAI.
 *
 * This mirrors the typical role/content pair used by chat-based language models:
 * - `system`: instructions that set overall behaviour,
 * - `user`: user-level prompt content,
 * - `assistant`: model-provided content.
 */
interface OpenAIChatMessage {
  /**
   * The role of the message within the chat.
   */
  role: "system" | "user" | "assistant";
  /**
   * The textual content of the message.
   */
  content: string;
}

/**
 * Maximum number of diff characters to forward to the model.
 *
 * This is used to truncate excessively large diffs before sending them to the
 * language model so prompts remain within token/size constraints.
 */
const MAX_DIFF_CHARACTERS = 12000;

/**
 * Maximum number of snippets to retain for each analysed file.
 *
 * When the analyser finds more added lines than can fit into the snippet
 * budget, only this many snippet containers will be kept.
 */
const MAX_SNIPPETS_PER_FILE = 3;

/**
 * Maximum number of lines captured for a single snippet.
 *
 * Ensures that each snippet remains compact and readable in the generated prompt.
 */
const MAX_LINES_PER_SNIPPET = 8;

/**
 * Heuristic detectors used to surface high-risk changes within the diff.
 *
 * Each entry contains:
 * - `id`: a short identifier,
 * - `description`: a human-friendly description used in reports,
 * - `test`: a predicate executed for each added line and file path to determine a match.
 *
 * The regexes are deliberately broad to surface changes that commonly affect
 * scalability, performance, or reliability (database queries, network calls,
 * loops, CPU-bound work, concurrency constructs, etc.).
 */
const HEURISTIC_CHECKS: Array<{
  id: string;
  description: string;
  test: (line: string, path: string) => boolean;
}> = [
  {
    id: "database",
    description: "Database or query-intensive changes",
    test: (line) =>
      /(select\s+.+from|insert\s+into|update\s+.+set|delete\s+from|prisma\.|supabase\.|knex\.|sequelize\.|db\.query|\bquery\s*\(|\.raw\s*\(|\.transaction\s*\(|\.aggregate\s*\()/i.test(
        line
      ),
  },
  {
    id: "api-endpoint",
    description: "New or modified API endpoint handlers",
    test: (line, path) =>
      /(router\.(get|post|put|patch|delete)|app\.(get|post|put|patch|delete)|export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)|handler\s*=\s*async|createPagesBrowserClient|NextResponse\.json|RequestHandler|Fastify\.)/i.test(
        line
      ) || /routes?\//i.test(path),
  },
  {
    id: "loops",
    description: "Loops or iterations that could amplify load",
    test: (line) =>
      /(for\s*\(|while\s*\(|for\s+await|\.map\(|\.filter\(|\.reduce\(|\.forEach\(|\.flatMap\(|for\s+const\s+\[|Promise\.all\s*\(|Promise\.allSettled\s*\()/i.test(
        line
      ),
  },
  {
    id: "external-calls",
    description: "Outbound network or third-party service calls",
    test: (line) => /(fetch\(|axios\.|got\.|request\(|graphql\(|supabase\.from|stripe\.|twilio\.|s3\.|storage\.|await\s+rpc\()/i.test(line),
  },
  {
    id: "cpu-intensive",
    description: "CPU-intensive work (encryption, parsing, etc.)",
    test: (line) => /(crypto\.|bcrypt\.|argon|scrypt|JSON\.parse|JSON\.stringify|zlib\.|pako\.|compression|image\.|sharp\.|for\s*\(.*length|Math\.(pow|sqrt|log)|new\s+RegExp)/i.test(line),
  },
  {
    id: "concurrency",
    description: "Explicit concurrency or worker usage",
    test: (line) => /(queue\.|worker\.|Bull\.|broker\.|cluster\.|threads\.|setImmediate|setTimeout|Atomics\.|SharedArrayBuffer)/i.test(line),
  },
];

/**
 * Analyses a unified diff to count added lines, extract snippets, and surface heuristics.
 *
 * The function scans a Git unified diff string line-by-line, registers files when
 * it encounters `+++ ` headers, tracks hunk locations (`@@ ... @@`) and collects
 * added lines (lines that start with `+`). For each added line it:
 *  - increments the file's `addedLines` counter,
 *  - appends the content to an open `Snippet` (subject to `MAX_LINES_PER_SNIPPET` and
 *    `MAX_SNIPPETS_PER_FILE` limits),
 *  - executes each `HEURISTIC_CHECKS` rule and records triggered heuristic descriptions.
 *
 * @param diff - Unified diff content, typically in Git format.
 * @returns Structured summary of the diff emphasising risky changes.
 */
function analyseDiff(diff: string): AnalysisSummary {
  const files = new Map<string, FileAnalysis>();
  let currentFile: FileAnalysis | null = null;
  let currentSnippet: Snippet | null = null;
  let currentLocation: string | null = null;

  const registerFile = (path: string) => {
    const normalized = path.startsWith("b/") ? path.slice(2) : path;
    if (!files.has(normalized)) {
      files.set(normalized, {
        path: normalized,
        addedLines: 0,
        heuristics: [],
        snippets: [],
      });
    }
    currentFile = files.get(normalized) ?? null;
    currentSnippet = null;
    currentLocation = null;
  };

  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith("diff --git")) {
      currentFile = null;
      currentSnippet = null;
      currentLocation = null;
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      const path = rawLine.substring(4).trim();
      if (path !== "/dev/null") {
        registerFile(path);
      }
      continue;
    }
    if (rawLine.startsWith("@@")) {
      currentLocation = rawLine.trim();
      currentSnippet = null;
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      if (!currentFile) {
        continue;
      }
      const file: FileAnalysis = currentFile;

      const line = rawLine.substring(1);
      file.addedLines += 1;

      let snippet: Snippet | null = currentSnippet;
      const snippetTracked = snippet ? file.snippets.includes(snippet) : false;

      if (!snippet || !snippetTracked || snippet.lines.length >= MAX_LINES_PER_SNIPPET) {
        if (file.snippets.length < MAX_SNIPPETS_PER_FILE) {
          const newSnippet: Snippet = {
            location: currentLocation,
            lines: [],
          };
          file.snippets.push(newSnippet);
          snippet = newSnippet;
        } else {
          snippet = null;
        }
      }

      if (snippet) {
        snippet.lines.push(line);
        currentSnippet = snippet;
      } else {
        currentSnippet = null;
      }

      for (const heuristic of HEURISTIC_CHECKS) {
        if (heuristic.test(line, file.path)) {
          if (!file.heuristics.includes(heuristic.description)) {
            file.heuristics.push(heuristic.description);
          }
        }
      }

      continue;
    }

    currentSnippet = null;
  }

  const fileAnalyses = Array.from(files.values()).filter((file) => file.addedLines > 0);
  const highlighted = new Set<string>();
  for (const file of fileAnalyses) {
    for (const heuristic of file.heuristics) {
      highlighted.add(heuristic);
    }
  }
  return { files: fileAnalyses, highlightedTags: Array.from(highlighted) };
}

/**
 * Formats the analysis summary into markdown suitable for the prompting context.
 *
 * The function produces a compact, human-readable representation of each analysed
 * file, including the number of added lines, any triggered signals (heuristics),
 * and snippet previews. Snippets are indented for readability.
 *
 * @param summary - Aggregated diff summary to convert into human-readable text.
 * @returns Markdown string that highlights files, signals, and snippets.
 */
function buildHeuristicSummary(summary: AnalysisSummary): string {
  if (summary.files.length === 0) {
    return "No added lines detected in the diff.";
  }

  return summary.files
    .map((file) => {
      const lines: string[] = [];
      lines.push(`? File: ${file.path}`);
      lines.push(`  Added lines: ${file.addedLines}`);
      if (file.heuristics.length > 0) {
        lines.push(`  Signals: ${file.heuristics.join(", ")}`);
      }
      if (file.snippets.length > 0) {
        const snippetPreviews = file.snippets
          .map((snippet) => {
            const header = snippet.location ? `${snippet.location}\n` : "";
            return `${header}${snippet.lines.join("\n")}`;
          })
          .join("\n---\n");
        lines.push("  Snippets:\n" + indentText(snippetPreviews, 4));
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Indents every line in the provided text by the specified number of spaces.
 *
 * Useful for producing readable snippet blocks inside the heuristic summary.
 *
 * @param text - The text block to indent. Newlines are preserved.
 * @param spaces - Number of spaces to prefix each line with.
 * @returns The indented text block.
 */
function indentText(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split(/\r?\n/)
    .map((line) => pad + line)
    .join("\n");
}

/**
 * Constructs the chat completion prompt for the OpenAI API.
 *
 * The returned array is an ordered list of `OpenAIChatMessage` objects where the
 * first entry is a `system` message establishing the assistant role and the
 * second entry is a `user` message containing a detailed, structured prompt
 * including the heuristic summary and the diff to analyse.
 *
 * @param params - Prompt configuration, including language, traffic profile, and diff details.
 * @param params.language - Primary stack or language focus (e.g., "TypeScript").
 * @param params.trafficProfile - The traffic/load profile to model (e.g., "1k-100k requests per second").
 * @param params.heuristicSummary - Summary produced by `buildHeuristicSummary`.
 * @param params.diff - The unified diff text to include in the prompt; already truncated if necessary.
 * @param params.truncated - `true` if the original diff was truncated prior to prompting.
 * @returns Ordered list of chat messages describing the task.
 */
function buildPrompt(params: {
  language: string;
  trafficProfile: string;
  heuristicSummary: string;
  diff: string;
  truncated: boolean;
}): OpenAIChatMessage[] {
  const { language, trafficProfile, heuristicSummary, diff, truncated } = params;

  const systemMessage: OpenAIChatMessage = {
    role: "system",
    content:
      "You are Scale Sentry, an elite performance engineer. Evaluate pull request diffs to forecast scalability risks, pinpoint bottlenecks, and recommend mitigation with evidence-backed reasoning.",
  };

  const userSections = [
    `Primary stack focus: ${language}`,
    `Traffic scenario to model: ${trafficProfile}`,
    `Heuristic highlights (derived automatically):\n${heuristicSummary}`,
  ];

  if (truncated) {
    userSections.push(
      "Note: The diff exceeded the analyzer limit and was truncated. Call this out explicitly if it affects confidence."
    );
  }

  userSections.push(
    "Please respond with GitHub-flavoured Markdown using this structure:\n" +
      "1. **Summary** ? bullet list of the top 3 risks or 'No significant scalability risks detected'.\n" +
      "2. **Simulated Bottlenecks** ? Markdown table with columns Component, Predicted Issue, Load Threshold (req/s), Latency Impact (ms), Confidence (%).\n" +
      "3. **Recommended Fixes** ? ordered list with actionable optimisations aligned to the issues.\n" +
      "4. **Quick Wins** ? bullet list of low-effort improvements or 'None'.\n" +
      "5. **Confidence** ? percentage with a one-sentence justification.\n" +
      "If information is missing, state assumptions instead of inventing details."
  );

  userSections.push(`Diff to analyse (Git unified format):\n\n\`\`\`diff\n${diff}\n\`\`\``);

  const userMessage: OpenAIChatMessage = {
    role: "user",
    content: userSections.join("\n\n"),
  };

  return [systemMessage, userMessage];
}

/**
 * Retrieves the diff for a pull request using the provided Octokit client.
 *
 * The function uses the GitHub API to fetch details for a pull request and
 * requests the response in unified-diff format by setting the `Accept` header
 * to `application/vnd.github.v3.diff`.
 *
 * @param octokit - Authenticated Octokit instance returned by `github.getOctokit`.
 * @param pullNumber - Pull request number to fetch.
 * @returns Raw diff text returned by the GitHub API as a string. Returns an
 *          empty string if the API response does not contain textual data.
 */
async function fetchPullRequestDiff(octokit: ReturnType<typeof github.getOctokit>, pullNumber: number) {
  const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...github.context.repo,
    pull_number: pullNumber,
    headers: { Accept: "application/vnd.github.v3.diff" },
  });
  return typeof response.data === "string" ? response.data : String(response.data ?? "");
}

/**
 * Calls the OpenAI chat completions endpoint with the prepared prompt.
 *
 * This wrapper adapts our `OpenAIChatMessage` format to the `ai` SDK's
 * `generateText` helper and enforces a predictable error surface. The function
 * will trim the returned text and throw an Error if no textual content is present.
 *
 * @param params - Parameters required to invoke the OpenAI API.
 * @param params.apiKey - API key used to construct the OpenAI client.
 * @param params.model - Model identifier (for example "gpt-4o" or other model alias supported by your SDK).
 * @param params.messages - An ordered set of chat messages (system + user).
 * @param params.maxTokens - Maximum tokens to request from the model for the output.
 * @param params.temperature - Sampling temperature between 0 and 1.
 * @returns Assistant response content trimmed for whitespace.
 * @throws If the API responds with a non-OK status or lacks textual content.
 */
async function callOpenAI(params: {
  apiKey: string;
  model: string;
  messages: OpenAIChatMessage[];
  maxTokens: number;
  temperature: number;
}): Promise<string> {
  const { apiKey, model, messages, maxTokens, temperature } = params;

  const aiClient = createOpenAI({ apiKey });
  const aiMessages: CoreMessage[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  try {
    const result = await generateText({
      model: aiClient.chat(model),
      messages: aiMessages,
      maxOutputTokens: maxTokens,
      temperature,
    });

    const text = result.text.trim();
    if (!text) {
      throw new Error("OpenAI response did not include textual content");
    }
    return text;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`OpenAI SDK request failed: ${error.message}`);
    }
    throw new Error("OpenAI SDK request failed with an unknown error");
  }
}

/**
 * Builds the final markdown report that will be posted or surfaced in outputs.
 *
 * The report contains a short header with repository and PR metadata followed by
 * the model's content. If the diff was truncated, the header will include a
 * note to that effect.
 *
 * @param params - Report construction parameters including metadata and model output.
 * @param params.pullNumber - Pull request number the report is for.
 * @param params.repoFullName - The repository's "owner/repo" string.
 * @param params.model - The model identifier used to produce the analysis.
 * @param params.content - The textual content produced by the model (assumed to be Markdown).
 * @param params.truncated - If `true` a "Diff truncated" note will be appended to the header.
 * @returns Markdown report summarising model findings.
 */
function buildReport(params: {
  pullNumber: number;
  repoFullName: string;
  model: string;
  content: string;
  truncated: boolean;
}): string {
  const { pullNumber, repoFullName, model, content, truncated } = params;
  const header = `## Scalability Simulator Report\n- Repository: ${repoFullName}\n- Pull Request: #${pullNumber}\n- Model: ${model}${truncated ? "\n- Note: Diff truncated for analysis" : ""}`;
  const footer = "\n---\nGenerated by Scale Sentry AI";
  return `${header}\n\n${content}\n${footer}`;
}

/**
 * Entrypoint for the GitHub Action that orchestrates diff retrieval, analysis, and reporting.
 *
 * Behaviour summary:
 * 1. Validate that the action is running in the context of a pull request.
 * 2. Read required inputs (github-token, openai-api-key) and optional configuration.
 * 3. Fetch the PR diff using the GitHub REST API and request it in unified-diff format.
 * 4. Truncate the diff if it exceeds `MAX_DIFF_CHARACTERS`.
 * 5. Analyse the diff using `analyseDiff` and build a heuristic summary.
 * 6. Construct a prompt and call the configured OpenAI model to obtain analysis.
 * 7. Build a report, set it as an action output, optionally write to the job summary,
 *    and optionally post the report as a PR comment.
 *
 * The function sets action outputs and marks the action as failed using `core.setFailed`
 * for user-facing errors (such as missing inputs).
 */
async function run(): Promise<void> {
  try {
    core.debug("Scale Sentry AI dependencies loaded (@actions/core, @actions/github) // typescript");

    const pullRequest = github.context.payload.pull_request;
    if (!pullRequest) {
      core.info("No pull request context detected. Skipping Scale Sentry AI analysis.");
      core.setOutput("report", "Skipped: Scale Sentry AI only analyses pull request diffs.");
      return;
    }

    const githubToken = core.getInput("github-token").trim();
    if (!githubToken) {
      core.setFailed(
        "Missing required input 'github-token'. Provide one via the workflow input (for example secrets.GITHUB_TOKEN)."
      );
      return;
    }

    const openaiApiKey = core.getInput("openai-api-key").trim();
    if (!openaiApiKey) {
      core.setFailed(
        "Missing required input 'openai-api-key'. Supply an OpenAI API key secret (for example secrets.OPENAI_API_KEY)."
      );
      return;
    }

    const targetLanguage = core.getInput("target-language") || "TypeScript";
    const trafficProfile = core.getInput("traffic-profile") || "1k-100k requests per second";
    const openaiModel = core.getInput("openai-model") || "gpt-4o";
    const maxTokensInput = core.getInput("openai-max-tokens");
    const maxTokens = maxTokensInput ? Number(maxTokensInput) : 900;
    const temperatureInput = core.getInput("openai-temperature");
    const temperature = temperatureInput ? Number(temperatureInput) : 0.2;

    const postCommentInput = core.getInput("post-comment") || "true";
    const postComment = postCommentInput.trim().toLowerCase() !== "false";
    const summaryInput = core.getInput("write-job-summary") || "true";
    const includeSummary = summaryInput.trim().toLowerCase() !== "false";

    if (Number.isNaN(maxTokens) || maxTokens <= 0) {
      throw new Error("openai-max-tokens must be a positive number");
    }
    if (Number.isNaN(temperature) || temperature < 0 || temperature > 1) {
      throw new Error("openai-temperature must be between 0 and 1");
    }

    const pullNumber = pullRequest.number;
    const octokit = github.getOctokit(githubToken);

    core.info(`Fetching diff for PR #${pullNumber}...`);
    const rawDiff = await fetchPullRequestDiff(octokit, pullNumber);
    if (!rawDiff.trim()) {
      core.warning("No diff content retrieved. Skipping analysis.");
      core.setOutput("report", "No diff content available for analysis.");
      return;
    }

    const truncated = rawDiff.length > MAX_DIFF_CHARACTERS;
    const diffForPrompt = truncated
      ? `${rawDiff.slice(0, MAX_DIFF_CHARACTERS)}\n... (diff truncated after ${MAX_DIFF_CHARACTERS} characters)`
      : rawDiff;

    core.info("Analysing diff heuristics...");
    const summary = analyseDiff(diffForPrompt);
    const heuristicSummary = buildHeuristicSummary(summary);

    const messages = buildPrompt({
      language: targetLanguage,
      trafficProfile,
      heuristicSummary,
      diff: diffForPrompt,
      truncated,
    });

    core.info(`Requesting analysis from OpenAI model '${openaiModel}'...`);
    const content = await callOpenAI({
      apiKey: openaiApiKey,
      model: openaiModel,
      messages,
      maxTokens,
      temperature,
    });

    const repoFullName = `${github.context.repo.owner}/${github.context.repo.repo}`;
    const report = buildReport({
      pullNumber,
      repoFullName,
      model: openaiModel,
      content,
      truncated,
    });

    core.setOutput("report", report);

    if (includeSummary) {
      await core.summary.addRaw(report).write();
    }

    if (postComment) {
      core.info("Posting report as a pull request comment...");
      await octokit.rest.issues.createComment({
        ...github.context.repo,
        issue_number: pullNumber,
        body: report,
      });
    } else {
      core.info("post-comment set to false. Skipping PR comment.");
    }

    core.info("Scalability analysis complete.");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unknown error occurred");
    }
  }
}

void run();
