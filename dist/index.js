"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const MAX_DIFF_CHARACTERS = 12000;
const MAX_SNIPPETS_PER_FILE = 3;
const MAX_LINES_PER_SNIPPET = 8;
const HEURISTIC_CHECKS = [
    {
        id: "database",
        description: "Database or query-intensive changes",
        test: (line) => /(select\s+.+from|insert\s+into|update\s+.+set|delete\s+from|prisma\.|supabase\.|knex\.|sequelize\.|db\.query|\bquery\s*\(|\.raw\s*\(|\.transaction\s*\(|\.aggregate\s*\()/i.test(line),
    },
    {
        id: "api-endpoint",
        description: "New or modified API endpoint handlers",
        test: (line, path) => /(router\.(get|post|put|patch|delete)|app\.(get|post|put|patch|delete)|export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)|handler\s*=\s*async|createPagesBrowserClient|NextResponse\.json|RequestHandler|Fastify\.)/i.test(line) || /routes?\//i.test(path),
    },
    {
        id: "loops",
        description: "Loops or iterations that could amplify load",
        test: (line) => /(for\s*\(|while\s*\(|for\s+await|\.map\(|\.filter\(|\.reduce\(|\.forEach\(|\.flatMap\(|for\s+const\s+\[|Promise\.all\s*\(|Promise\.allSettled\s*\()/i.test(line),
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
            if (!currentFile) {
                continue;
            }
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
                }
                else {
                    snippet = null;
                }
            }
            if (snippet) {
                snippet.lines.push(line);
                currentSnippet = snippet;
            }
            else {
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
    const highlighted = new Set();
    for (const file of fileAnalyses) {
        for (const heuristic of file.heuristics) {
            highlighted.add(heuristic);
        }
    }
    return { files: fileAnalyses, highlightedTags: Array.from(highlighted) };
}
function buildHeuristicSummary(summary) {
    if (summary.files.length === 0) {
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
    return text
        .split(/\r?\n/)
        .map((line) => pad + line)
        .join("\n");
}
function buildPrompt(params) {
    const { language, trafficProfile, heuristicSummary, diff, truncated } = params;
    const systemMessage = {
        role: "system",
        content: "You are Scale Sentry, an elite performance engineer. Evaluate pull request diffs to forecast scalability risks, pinpoint bottlenecks, and recommend mitigation with evidence-backed reasoning.",
    };
    const userSections = [
        `Primary stack focus: ${language}`,
        `Traffic scenario to model: ${trafficProfile}`,
        `Heuristic highlights (derived automatically):\n${heuristicSummary}`,
    ];
    if (truncated) {
        userSections.push("Note: The diff exceeded the analyzer limit and was truncated. Call this out explicitly if it affects confidence.");
    }
    userSections.push("Please respond with GitHub-flavoured Markdown using this structure:\n" +
        "1. **Summary** ? bullet list of the top 3 risks or 'No significant scalability risks detected'.\n" +
        "2. **Simulated Bottlenecks** ? Markdown table with columns Component, Predicted Issue, Load Threshold (req/s), Latency Impact (ms), Confidence (%).\n" +
        "3. **Recommended Fixes** ? ordered list with actionable optimisations aligned to the issues.\n" +
        "4. **Quick Wins** ? bullet list of low-effort improvements or 'None'.\n" +
        "5. **Confidence** ? percentage with a one-sentence justification.\n" +
        "If information is missing, state assumptions instead of inventing details.");
    userSections.push(`Diff to analyse (Git unified format):\n\n\`\`\`diff\n${diff}\n\`\`\``);
    const userMessage = {
        role: "user",
        content: userSections.join("\n\n"),
    };
    return [systemMessage, userMessage];
}
async function fetchPullRequestDiff(octokit, pullNumber) {
    const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        ...github.context.repo,
        pull_number: pullNumber,
        headers: { Accept: "application/vnd.github.v3.diff" },
    });
    return typeof response.data === "string" ? response.data : String(response.data ?? "");
}
async function callOpenAI(params) {
    const { apiKey, model, messages, maxTokens, temperature } = params;
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
        }),
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenAI API request failed (${response.status}): ${errorBody}`);
    }
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
        throw new Error("OpenAI response did not include textual content");
    }
    return content.trim();
}
function buildReport(params) {
    const { pullNumber, repoFullName, model, content, truncated } = params;
    const header = `## Scalability Simulator Report\n- Repository: ${repoFullName}\n- Pull Request: #${pullNumber}\n- Model: ${model}${truncated ? "\n- Note: Diff truncated for analysis" : ""}`;
    const footer = "\n---\nGenerated by Scale Sentry AI";
    return `${header}\n\n${content}\n${footer}`;
}
async function run() {
    try {
        const pullRequest = github.context.payload.pull_request;
        if (!pullRequest) {
            core.info("No pull request context detected. Skipping Scale Sentry AI analysis.");
            core.setOutput("report", "Skipped: Scale Sentry AI only analyses pull request diffs.");
            return;
        }
        const githubToken = core.getInput("github-token").trim();
        if (!githubToken) {
            core.setFailed("Missing required input 'github-token'. Provide one via the workflow input (for example secrets.GITHUB_TOKEN).");
            return;
        }
        const openaiApiKey = core.getInput("openai-api-key").trim();
        if (!openaiApiKey) {
            core.setFailed("Missing required input 'openai-api-key'. Supply an OpenAI API key secret (for example secrets.OPENAI_API_KEY).");
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
        }
        else {
            core.info("post-comment set to false. Skipping PR comment.");
        }
        core.info("Scalability analysis complete.");
    }
    catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message);
        }
        else {
            core.setFailed("An unknown error occurred");
        }
    }
}
void run();
