# Contributing to Scale Sentry AI

Thanks for your interest in improving the project! Please take a minute to review this guide so we can keep the workflow smooth for everyone.

## Getting Set Up

1. Fork the repository and clone it locally.
2. Install dependencies with `npm install`.
3. Build once with `npm run build`; use `npm run build -- --watch` while iterating.
4. Ensure `dist/` stays in sync with `src/` before you push changes (run a final `npm run build`).

## Branching & Commits

- Use descriptive branches, for example `feat/add-django-heuristics`.
- Keep commits focused and include clear messages (`fix: handle truncated diffs in prompt`).
- Do not force-push to main; open a pull request.

## Pull Request Checklist

- [ ] `npm run build` succeeds and emits updated files in `dist/`.
- [ ] Lint/formatting checks pass (if added to the repo).
- [ ] Tests or manual validation steps are documented when behaviour changes.
- [ ] README and docs updated when inputs, outputs, or prompts change.
- [ ] No secrets or sensitive data included in commits or logs.

## Coding Guidelines

- Stick to TypeScript with strict mode (`tsconfig.json`).
- Prefer small, composable functions and keep heuristics declarative.
- Add comments sparingly; only where intent is non-obvious.
- Follow existing naming conventions and file structure.

## Prompts & Heuristics

- When adjusting prompts, test against a variety of diffs (database heavy, API routes, CPU workloads).
- Add new heuristic IDs with clear descriptions; avoid duplicating current checks.
- Document meaningful prompt or heuristic changes in the PR description.

## Reporting Issues

- Include a reproduction (workflow logs, diff snippets, model settings) to help us triage quickly.
- Tag issues with appropriate labels (`bug`, `enhancement`, `documentation`).

## Code of Conduct

Be respectful and collaborative. Harassment or discrimination won't be tolerated. If you witness or experience inappropriate conduct, reach out to the maintainers.

Happy scaling!
