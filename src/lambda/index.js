/**
 * scale-sentry-lambda - AWS Lambda handler to analyse GitHub PR diffs for scalability risks
 *
 * Environment variables (recommended):
 *  - GITHUB_TOKEN           : GitHub token with repo access (required unless provided in event)
 *  - OPENAI_API_KEY         : OpenAI API key (required unless provided in event)
 *  - TARGET_LANGUAGE        : default "TypeScript"
 *  - TRAFFIC_PROFILE        : default "1k-100k requests per second"
 *  - OPENAI_MODEL           : default "gpt-4o" (or whichever model you want)
 *  - OPENAI_MAX_TOKENS      : default 900
 *  - OPENAI_TEMPERATURE     : default 0.2
 *  - POST_COMMENT           : "true" or "false" (default "true")
 *  - WRITE_JOB_SUMMARY      : "true" or "false" (unused in Lambda but kept for parity)
 *
 * The Lambda expects event to include:
 *  {
 *    owner, repo, pull_number,
 *    github_token?, openai_api_key?,
 *    ...override other inputs if desired
 *  }
 *
 * Response:
 *  JSON { statusCode, body: { report, truncated, summary } }
 */

const { Octokit } = require("@octokit/rest");

// Heuristic and utility constants copied/adapted from your Action
const MAX_DIFF_CHARACTERS = 12000;
const MAX_SNIPPETS_PER_FILE = 3;
const MAX_LINES_PER_SNIPPET = 8;

const HEURISTIC_CHECKS = [
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

/* ----------------------------- Utilities ------------------------------ */

/**
 * Analyse unified git diff string and extract files with added lines,
 * snippets, and heuristics.
 * @param {string} diff
 * @returns {{files: Array, highlightedTags:Array}}
 */
function analyseDiff(diff) {
  const files = new Map();
  let currentFile = null;
  let currentSnippet = null;
  let currentLocation = null;

  const registerFile = (path) => {
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
      if (!currentFile) continue;
      const file = currentFile;
      const line = rawLine.substring(1);
      file.addedLines += 1;

      let snippet = currentSnippet;
      const snippetTracked = snippet ? file.snippets.includes(snippet) : false;

      if (!snippet || !snippetTracked || snippet.lines.length >= MAX_LINES_PER_SNIPPET) {
        if (file.snippets.length < MAX_SNIPPETS_PER_FILE) {
          const newSnippet = {
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
        try {
          if (heuristic.test(line, file.path)) {
            if (!file.heuristics.includes(heuristic.description)) {
              file.heuristics.push(heuristic.description);
            }
          }
        } catch (e) {
          // ignore heuristic errors for robustness
        }
      }
      continue;
    }

    currentSnippet = null;
  }

  const fileAnalyses = Array.from(files.values()).filter((f) => f.addedLines > 0);
  const highlighted = new Set();
  for (const f of fileAnalyses) {
    for (const h of f.heuristics) highlighted.add(h);
  }
  return { files: fileAnalyses, highlightedTags: Array.from(highlighted) };
}

/**
 * Build heurstic summary in text/markdown to include in model prompt.
 * @param {*} summary
 * @returns {string}
 */
function buildHeuristicSummary(summary) {
  if (!summary.files || summary.files.length === 0) {
    return "No added lines detected in the diff.";
  }
  return summary.files
    .map((file) => {
      const lines = [];
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

function indentText(text, spaces) {
  const pad = " ".repeat(spaces);
  return text.split(/\r?\n/).map((l) => pad + l).join("\n");
}

/**
 * Build messages for the chat model (system + user)
 */
function buildPrompt({ language, trafficProfile, heuristicSummary, diff, truncated }) {
  const systemMessage = {
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
      "1. **Summary** – bullet list of the top 3 risks or 'No significant scalability risks detected'.\n" +
      "2. **Simulated Bottlenecks** – Markdown table with columns Component, Predicted Issue, Load Threshold (req/s), Latency Impact (ms), Confidence (%).\n" +
      "3. **Recommended Fixes** – ordered list with actionable optimisations aligned to the issues.\n" +
      "4. **Quick Wins** – bullet list of low-effort improvements or 'None'.\n" +
      "5. **Confidence** – percentage with a one-sentence justification.\n" +
      "If information is missing, state assumptions instead of inventing details."
  );

  userSections.push(`Diff to analyse (Git unified format):\n\n\`\`\`diff\n${diff}\n\`\`\``);

  const userMessage = {
    role: "user",
    content: userSections.join("\n\n"),
  };

  return [systemMessage, userMessage];
}

/* -------------------------- GitHub / OpenAI wrappers --------------------------- */

/**
 * Fetch PR diff using Octokit (returns unified diff string)
 */
async function fetchPullRequestDiff(octokit, owner, repo, pullNumber) {
  const resp = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: pullNumber,
    headers: { Accept: "application/vnd.github.v3.diff" },
  });
  return typeof resp.data === "string" ? resp.data : String(resp.data ?? "");
}

/**
 * Call OpenAI Chat Completions via fetch (v1 chat/completions)
 * Uses messages: [{role,content}, ...]
 */
async function callOpenAI_v1({ apiKey, model, messages, maxTokens, temperature }) {
  if (!apiKey) throw new Error("OpenAI API key not provided to callOpenAI_v1");

  const url = "https://api.openai.com/v1/chat/completions";
  const payload = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI API error: ${resp.status} ${resp.statusText} - ${text}`);
  }

  const data = await resp.json();
  // typical shape: data.choices[0].message.content
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  return content.trim();
}

/* ------------------------------- Lambda Handler ------------------------------ */

/**
 * AWS Lambda handler
 *
 * Accepts event object with:
 *  - owner, repo, pull_number (required)
 *  - github_token? openai_api_key? other overrides for inputs
 *
 * Returns JSON with the generated report.
 */
exports.handler = async function (event) {
  try {
    // --- configuration (env or event override)
    const owner = event.owner || (event.owner_repo && event.owner_repo.split("/")[0]) || process.env.PR_OWNER;
    const repo = event.repo || (event.owner_repo && event.owner_repo.split("/")[1]) || process.env.PR_REPO;
    const pullNumber = event.pull_number || event.pullNumber || Number(process.env.PR_NUMBER);

    if (!owner || !repo || !pullNumber) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "owner, repo and pull_number are required (pass in event or set env PR_OWNER/PR_REPO/PR_NUMBER)",
        }),
      };
    }

    const githubToken = event.github_token || process.env.GITHUB_TOKEN;
    const openaiApiKey = event.openai_api_key || process.env.OPENAI_API_KEY;

    if (!githubToken) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing GITHUB_TOKEN" }) };
    }
    if (!openaiApiKey) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };
    }

    const targetLanguage = event.target_language || process.env.TARGET_LANGUAGE || "TypeScript";
    const trafficProfile = event.traffic_profile || process.env.TRAFFIC_PROFILE || "1k-100k requests per second";
    const openaiModel = event.openai_model || process.env.OPENAI_MODEL || "gpt-4o";
    const maxTokens = Number(event.openai_max_tokens || process.env.OPENAI_MAX_TOKENS || 900);
    const temperature = Number(event.openai_temperature || process.env.OPENAI_TEMPERATURE || 0.2);

    const postCommentInput = event.post_comment ?? process.env.POST_COMMENT ?? "true";
    const postComment = String(postCommentInput).trim().toLowerCase() !== "false";

    // --- Octokit client
    const octokit = new Octokit({ auth: githubToken });

    // --- fetch diff
    const rawDiff = await fetchPullRequestDiff(octokit, owner, repo, pullNumber);
    if (!rawDiff || !rawDiff.trim()) {
      return { statusCode: 200, body: JSON.stringify({ report: "No diff content available for analysis." }) };
    }

    const truncated = rawDiff.length > MAX_DIFF_CHARACTERS;
    const diffForPrompt = truncated
      ? `${rawDiff.slice(0, MAX_DIFF_CHARACTERS)}\n... (diff truncated after ${MAX_DIFF_CHARACTERS} characters)`
      : rawDiff;

    // --- analyse
    const summary = analyseDiff(diffForPrompt);
    const heuristicSummary = buildHeuristicSummary(summary);

    // --- build prompt/messages
    const messages = buildPrompt({
      language: targetLanguage,
      trafficProfile,
      heuristicSummary,
      diff: diffForPrompt,
      truncated,
    });

    // --- call OpenAI
    const content = await callOpenAI_v1({
      apiKey: openaiApiKey,
      model: openaiModel,
      messages,
      maxTokens,
      temperature,
    });

    // --- build report
    const repoFullName = `${owner}/${repo}`;
    const header = `## Scalability Simulator Report\n- Repository: ${repoFullName}\n- Pull Request: #${pullNumber}\n- Model: ${openaiModel}${truncated ? "\n- Note: Diff truncated for analysis" : ""}`;
    const footer = "\n---\nGenerated by Scale Sentry AI (Lambda)";
    const report = `${header}\n\n${content}\n${footer}`;

    // --- optionally post as PR comment
    if (postComment) {
      try {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body: report,
        });
      } catch (e) {
        // do not fail the Lambda just because the comment failed; include error in response
        return {
          statusCode: 200,
          body: JSON.stringify({
            report,
            truncated,
            warning: `Failed to post comment: ${String(e.message || e)}`,
          }),
        };
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        report,
        truncated,
        summary,
      }),
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return { statusCode: 500, body: JSON.stringify({ error: msg }) };
  }
};
