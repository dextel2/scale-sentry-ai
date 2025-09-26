# Known Issues

This document tracks limitations and rough edges that contributors should be aware of.

## 1. Diff Truncation
- Diff content is truncated at 12,000 characters before it is sent to OpenAI.
- Large pull requests may lose context, which can reduce confidence in the generated report.
- Workaround: Split massive changes into smaller PRs or raise the limit (with cost considerations).

## 2. Heuristic Noise
- Current heuristics may flag benign changes, especially in files with many utility functions.
- False positives can make the report feel repetitive.
- Planned fix: incorporate file-level weighting or historical profiling data.

## 3. External Service Dependencies
- Calls to OpenAI depend on the external API being available and the secret being valid.
- Network hiccups or quota exhaustion cause the Action to fail.
- Future enhancement: retry mechanism with exponential backoff.

## 4. Cost Visibility
- Reports do not currently include the estimated token usage or cost per run.
- Users may have trouble budgeting for heavy PR traffic.
- Idea: add optional logging of token counts via the `usage` field returned by OpenAI.

Feel free to file an issue or open a PR if you have ideas for addressing any of the above.
