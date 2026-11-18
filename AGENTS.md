# Repository Guidelines

## Project Structure

This repository is a scaffold for `nolen-ai-short-assistant`. The README currently contains the project name. Use the existing workspace directories as starting points when adding the first implementation.

- `clients/` for client applications and their assets.
- `servers/` for server components and their tests.
- `scripts/` for repeatable development and maintenance commands.
- `docs/` for project documentation and `references/` for supporting material.

These directories are currently empty. Git tracks files, so a fresh clone may require you to create the relevant directory when adding its first file.

## Development and Testing

The project has no configured build, local run, lint, or test command yet. When introducing a runnable component, document its prerequisites, working directory, and exact setup and run commands in `README.md`. Include a command that a reviewer can use to verify the change from a fresh checkout.

No test framework, test filename pattern, or coverage threshold has been established. For the first tested component, follow its framework's test discovery convention and document how to run one test and the full suite.

## Coding Style and Naming

Choose indentation and filename conventions appropriate to the language of the first component. If you introduce a formatter or linter, commit its configuration alongside the code so contributors can reproduce the same results.

Add a short comment or docstring to every function and method. Explain its purpose and mention side effects or assumptions when relevant. Update the comment when behavior changes.

Check existing code before adding a dependency or abstraction. Keep edits focused and define an observable result for each change. [Ponytail](https://github.com/DietrichGebert/ponytail) and [Karpathy coding guidelines](https://github.com/multica-ai/andrej-karpathy-skills)

## Commits and Pull Requests

1. Start every feature on a new branch from the current main branch, for example, `git switch -c feat/short-preview`.
2. Commit each logical code change as soon as you verify it. Include its corresponding tests. Use a type, optional scope, and short description, for example, `feat(client): add short preview`. [Conventional Commits](https://github.com/conventional-commits/conventionalcommits.org)
3. Push the branch and open a pull request targeting main. Describe the change, list the checks you ran, and link the related issue when available.

## Document and Diagram References

Include source references in every document and beneath every diagram. Link the specification, decision, or source file that supports the content. For an original design, identify it as a proposal and link the requirement it addresses.
