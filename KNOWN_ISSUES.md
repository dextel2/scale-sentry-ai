Here’s a rewritten and more engaging version of your markdown with relevant emojis added:


# ⚠️ Known Issues

This document tracks current limitations and rough edges contributors should be aware of.  

---

## 1. 📝 Diff Truncation
- Diff content is **truncated at 12,000 characters** before being sent to OpenAI.
- Large pull requests may **lose context**, reducing confidence in the generated report.
- 💡 **Workaround:** Split massive changes into smaller PRs or increase the limit (note: may increase cost).

---

## 2. 🔍 Heuristic Noise
- Current heuristics may **flag benign changes**, especially in files with many utility functions.
- False positives can make reports feel **repetitive or noisy**.
- 🛠 **Planned fix:** Incorporate file-level weighting or historical profiling data.

---

## 3. 🌐 External Service Dependencies
- Calls to OpenAI **rely on the external API** and a valid secret.
- Network issues or quota exhaustion may cause the Action to **fail**.
- ⚡ **Future enhancement:** Implement a **retry mechanism with exponential backoff**.

---

## 4. 💰 Cost Visibility
- Reports **do not show estimated token usage or cost per run**.
- Users may have trouble **budgeting for high PR traffic**.
- 💡 **Idea:** Add optional logging of token counts using the `usage` field from OpenAI responses.

---

Feel free to **file an issue** or **open a PR** if you have suggestions for addressing any of the above! 🚀
```

