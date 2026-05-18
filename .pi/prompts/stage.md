---
description: "Run release staging: verify tests, update changelog, commit, and tag without pushing"
---
Stage a release for this project. Do not push commits or tags to any remote.

Follow these steps exactly:

1. Safety checks
   - Confirm you are in the repository root.
   - Inspect `git status --short` before changing anything. If there are unrelated or ambiguous pre-existing changes, stop and ask for guidance rather than committing them.
   - Do not run `git push`, `git push --tags`, or any command that publishes to `origin`.

2. Update tests
   - Find the latest tag with `git describe --tags --abbrev=0`.
   - Review changes since that tag with commands such as `git log --oneline <latest-tag>..HEAD` and `git diff --stat <latest-tag>..HEAD`.
   - Inspect the project's tests in `src/test/extension.test.ts` and ensure that all changes since the latest tag are covered.
     - If necessary, add or update tests to cover changes introduced since the latest tag.
     - Remove tests that are no longer needed or that are effectively redundant due to other tests.
     - If you made changes to tests, commit them with: `git commit -m "Update tests."`

3. Verify the project
   - Run the full validation/test suite for this repository:
     - `npm run compile`
     - `npm test`
   - If any validation or tests fail, investigate and make the necessary code/test changes.
   - Re-run the failed checks, and preferably the full suite, until everything passes.
   - If you made regression-fix changes, commit only those relevant changes with:
     - `git commit -m "Fix regressions."`
   - If no regression-fix changes were needed, do not create this commit.

4. Update `AGENTS.md`
   - Inspect changes since the last update of `AGENTS.md` in the Git history.
   - Update the file to reflect the current state of the project.
   - Commit the changes with: `git commit -m "Update agents file."`.

5. Determine the next version
   - Find the latest tag with `git describe --tags --abbrev=0`.
   - Review changes since that tag with commands such as `git log --oneline <latest-tag>..HEAD` and `git diff --stat <latest-tag>..HEAD`.
   - Choose the next version according to semantic versioning:
     - MAJOR for breaking changes.
     - MINOR for backwards-compatible new functionality.
     - PATCH for backwards-compatible bug fixes, documentation-only changes, and small maintenance changes.
   - Use the repository's existing tag style, which is a bare version like `0.1.0` with no `v` prefix.

6. Update `CHANGELOG.md`
   - Add a new version entry above the current latest entry.
   - Summarize the notable changes since the last tag.
   - Preserve the existing changelog style, including compare links at the bottom.
   - Add the appropriate compare link for the new version.

7. Commit and tag
   - Commit only the changelog changes with:
     - `git commit -m "Update changelog."`
   - Create a tag on the latest commit whose name is exactly the new version:
     - `git tag <new-version>`
   - Verify with `git status --short` and `git tag --points-at HEAD`.
   - Do not push anything. End by explicitly reporting that no commits or tags were pushed.
