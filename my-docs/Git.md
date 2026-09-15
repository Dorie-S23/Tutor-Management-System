# GitHub Collaboration Methodology

## Branching Strategy

The repository uses a feature-branch workflow to allow all team members to work simultaneously without interfering with each other's work.

### Main Branches

- **main**
  - Contains only stable and tested code.
  - Represents the latest production-ready version of the project.
  - Direct commits are not allowed.
- **develop**
  - Contains the latest integrated development version.
  - New features are merged here after review.
  - Direct commits should be avoided unless fixing merge conflicts or urgent team-approved changes.

### Feature Branches

Each new feature, bug fix, or documentation update should be completed in its own branch.

Examples:

- `feature/login-page`
- `feature/task-management`
- `feature/database-schema`
- `bugfix/task-delete`
- `bugfix/login-validation`
- `docs/github-methodology`

### When to Create a Branch

Create a new branch whenever:

- Starting a new feature
- Fixing a bug
- Refactoring code
- Updating documentation
- Performing experimental work

A branch should focus on one task only.

### Branch Naming Convention

Branches should use lowercase letters with hyphens.

Format:

```
feature/<feature-name>
bugfix/<bug-name>
docs/<document-name>
refactor/<component-name>
hotfix/<critical-fix>
```

Examples:

- `feature/create-task`
- `feature/user-authentication`
- `bugfix/archive-button`
- `docs/api-documentation`

## Committing Changes

Commits should represent one logical change. Avoid committing unrelated changes together.

### Good Commit Messages

Use the following format:

```
type: short description
```

Examples:

- `feat: add task creation page`
- `fix: resolve archive task bug`
- `docs: update installation guide`
- `style: improve button spacing`
- `refactor: simplify database queries`
- `test: add task creation tests`

Common commit types:

- `feat`
- `fix`
- `docs`
- `style`
- `refactor`
- `test`
- `chore`

### When to Commit

Commit whenever you complete a meaningful piece of work. Examples include:

- Completing a feature
- Fixing a bug
- Finishing a UI component
- Passing all tests after several related changes
- Before switching tasks
- Before opening a pull request

Avoid committing:

- Broken code
- Code that does not compile
- Half-finished experiments
- Temporary debugging code

Small, frequent commits are preferred over large commits.

## Pull Requests

Every completed branch should be submitted as a Pull Request.

The Pull Request should include:

- Summary of the changes
- Reason for the changes
- Screenshots (if UI changes were made)
- Related issue or task (if applicable)

### Requirements for Merging

A branch may only be merged if:

- The code builds successfully.
- All tests pass.
- The feature works as intended.
- No merge conflicts remain.
- At least one other team member reviews and approves the Pull Request.
- The code follows the team's coding standards.

No developer should merge their own Pull Request without at least one approval from another group member unless the entire team agrees.

### When to Merge

Merge feature branches into `develop` after:

- Development is complete.
- Testing has been completed.
- The Pull Request has been approved.

Merge `develop` into `main` only when:

- A project milestone is complete.
- A demonstration is approaching.
- A release has been fully tested.

## Versioning

The project follows Semantic Versioning.

Format:

```
MAJOR.MINOR.PATCH
```

**MAJOR** — Increase when significant or incompatible changes are introduced.
Example: `1.0.0 → 2.0.0`

**MINOR** — Increase when new features are added while remaining compatible.
Example: `1.2.0 → 1.3.0`

**PATCH** — Increase when fixing bugs without adding new functionality.
Example: `1.2.1 → 1.2.2`

### When to Create a Version

Create a new version whenever:

- A sprint or milestone is completed.
- The project is demonstrated.
- A stable release is delivered.
- Major functionality has been completed.

Do not create a new version after every commit.

## Collaboration Guidelines

To ensure smooth collaboration:

- Pull the latest changes before starting work.
- Push commits regularly to avoid losing work.
- Resolve merge conflicts promptly.
- Keep branches focused on a single task.
- Communicate with teammates before making major architectural changes.
- Review teammates' Pull Requests carefully before approving them.
- Delete feature branches after they have been merged.