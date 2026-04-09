#!/bin/sh
set -e

#
# This script is used to *cherry-pick* a commit from main into a release branch
# To use: Start on a release branch eg release/202X-XX-XX-XX-XX
# Run: yarn draft-hotfix-pr <commit-hash (short or full)>
#
# This creates a new branch hotfix/<release branch> with a PR to merge fix
# Once fix is merged cut a new release from this hotfix/ branch
#

# Ensure up to date
echo "Fetching latest changes..."
git fetch
echo "Done"

# variables
base_branch=$(git rev-parse --abbrev-ref HEAD)
cherry_pick_target=$(git rev-parse --short $1)

# Verify target commit is on main
if ! git branch -r origin/main --contains $commit_hash >/dev/null; then
  echo "Commit $commit_hash does not appear to be merged to main."
  exit 1
fi

# Verify on release branch
if [[ $base_branch != release/* ]]; then
  echo "Not on release branch: Current branch does not start with 'release/'"
  exit 1
fi

# Verify git status is clean
if ! git diff-index --quiet HEAD --; then
  echo "There are uncommitted changes. Please try to pull a clean commit into a clean release cut. See script code for details."
  # Details: *Ideally hotfixes are pulling a merged commit from main, into a clean release cut*
  #   Local changes could make things messy if cherry pick has a conflict
  #   We also don't want to push code that doesn't exist on main as that risks breaking on future deploys
  exit 1
fi

# Create new branch to cut release from (hotfix/...)
hotfix_branch="hotfix/$base_branch"
echo "Setting up hotfix branch $hotfix_branch..."
echo "- Creating branch $hotfix_branch"
git checkout -b $hotfix_branch

# Push hotfix branch to remote
echo "- Pushing $hotfix_branch"
git push origin $hotfix_branch

# Create and checkout new branch to stage fix
stage_branch="staged/$hotfix_branch"
echo "Staging fix in $stage_branch..."
echo "- Creating branch $stage_branch"
git checkout -b $stage_branch

# Cherry pick commit into branch
echo "- Cherry picking $cherry_pick_target"
git cherry-pick $cherry_pick_target

# Push fix-staging branch to remote
echo "- Pushing $stage_branch"
git push origin $stage_branch

# Return to base branch
git checkout $base_branch

# Open PR from staged branch into release branch
echo "Opening Fix PR..."
open https://github.com/Frameio/web-app/compare/$hotfix_branch...$stage_branch?quick_pull=1

echo "---!!!---"
echo "---!!!--- After merge cut new release from: $hotfix_branch"
echo "---!!!---"
