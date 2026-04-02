/* eslint-disable no-console */
/**
 * Headless hotfix script for CI — applies hotfix commit(s) to a release branch
 * via direct cherry-pick, then triggers release-preview to cut a new release.
 *
 * Happy path: cherry-picks land directly on the hotfix branch (preserving
 * the original commit message), no intermediate PRs.
 *
 * Conflict path: if a cherry-pick fails, the commit with conflict markers is
 * pushed to a staged branch and a PR is created for manual resolution. Once
 * resolved and merged, the dashboard auto-triggers release-preview.
 *
 * Usage (CI):
 *   npx tsx scripts/hotfix/hotfix.ts \
 *     --release-tag "@frameio/next-web-app@522.0" \
 *     --commits "abc1234,def5678" \
 *     [--skip-release-preview] \
 *     [--dry-run]
 *
 * Env:
 *   GITHUB_TOKEN  — required
 *   GITHUB_OUTPUT — set by Actions; outputs are written here
 */

import { execSync } from 'child_process';
import { appendFileSync } from 'fs';

const OWNER = process.env.GITHUB_OWNER || 'Frameio';
const REPO = process.env.GITHUB_REPO || 'web-app';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let releaseTag = '';
  let commits: string[] = [];
  let skipReleasePreview = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--release-tag' && args[i + 1]) {
      releaseTag = args[i + 1];
      i += 1;
    } else if (args[i] === '--commits' && args[i + 1]) {
      commits = args[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (args[i] === '--skip-release-preview') {
      skipReleasePreview = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  if (!releaseTag || commits.length === 0) {
    console.error(
      'Usage: --release-tag <tag> --commits <sha1,sha2,...> [--skip-release-preview] [--dry-run]'
    );
    process.exit(1);
  }

  return { releaseTag, commits, skipReleasePreview, dryRun };
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

const TOKEN = process.env.GITHUB_TOKEN;

async function ghApi(path: string, options?: RequestInit) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options?.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${path}\n${body}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

type GitHubRelease = {
  id: number;
  tag_name: string;
  target_commitish: string;
  name: string | null;
  body: string | null;
  draft: boolean;
};

async function getReleaseByTag(tag: string): Promise<GitHubRelease> {
  return ghApi(`/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
}

async function createPullRequest(
  head: string,
  base: string,
  title: string,
  body: string
): Promise<{ number: number; html_url: string }> {
  return ghApi(`/repos/${OWNER}/${REPO}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ head, base, title, body }),
  });
}

async function addPRComment(prNumber: number, body: string): Promise<void> {
  await ghApi(`/repos/${OWNER}/${REPO}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

async function dispatchWorkflow(
  workflowId: string,
  ref: string,
  inputs: Record<string, string>
): Promise<void> {
  await ghApi(
    `/repos/${OWNER}/${REPO}/actions/workflows/${workflowId}/dispatches`,
    {
      method: 'POST',
      body: JSON.stringify({ ref, inputs }),
    }
  );
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(cmd: string): string {
  console.log(`  $ git ${cmd}`);
  return execSync(`git ${cmd}`, { encoding: 'utf-8' }).trim();
}

function getCommitTitle(sha: string): string {
  return execSync(`git show -s --format=%s ${sha}`, { encoding: 'utf-8' }).trim();
}

function getConflictedFiles(): string[] {
  const status = execSync('git status --porcelain', { encoding: 'utf-8' });
  return status
    .split('\n')
    .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(l))
    .map((l) => l.slice(3).trim());
}

/**
 * Attempt a cherry-pick. Returns `true` if clean, `false` if conflict.
 * On conflict the working tree is left in a conflicted state (not committed).
 */
function tryCherryPick(sha: string): boolean {
  try {
    git(`cherry-pick ${sha}`);
    return true;
  } catch {
    const conflicted = getConflictedFiles();
    if (conflicted.length === 0) {
      throw new Error(`Cherry-pick of ${sha} failed (not a merge conflict)`);
    }
    return false;
  }
}

function validateCommit(sha: string, targetBranch: string): void {
  const onMain = execSync(
    `git branch -r origin/main --contains ${sha}`,
    { encoding: 'utf-8' }
  ).trim();
  if (!onMain) {
    throw new Error(`Commit ${sha} is not on main`);
  }

  const onTarget = execSync(
    `git branch -r origin/${targetBranch} --contains ${sha}`,
    { encoding: 'utf-8' }
  ).trim();
  if (onTarget) {
    throw new Error(`Commit ${sha} already exists on ${targetBranch}`);
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function setOutput(key: string, value: string) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
  console.log(`::set-output ${key}=${value}`);
}

function summary(text: string) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, `${text}\n`);
  }
}

// ---------------------------------------------------------------------------
// Cleanup on failure
// ---------------------------------------------------------------------------

async function cleanupBranches(branches: string[]) {
  for (const branch of branches) {
    try {
      git(`push origin --delete ${branch}`);
      console.log(`  Deleted remote branch: ${branch}`);
    } catch {
      console.log(`  Could not delete remote branch: ${branch} (may not exist)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { releaseTag, commits, skipReleasePreview, dryRun } = parseArgs();

  if (!TOKEN) {
    console.error('GITHUB_TOKEN is required');
    process.exit(1);
  }

  console.log(`\n🛠️  Hotfix Action`);
  console.log(`   Release: ${releaseTag}`);
  console.log(`   Commits: ${commits.join(', ')}`);
  console.log(`   Dry run: ${dryRun}`);
  console.log('');

  // 1. Fetch the release
  console.log('📥 Fetching release...');
  const release = await getReleaseByTag(releaseTag);
  const releaseBranch = release.target_commitish;
  console.log(`   Release branch: ${releaseBranch}`);
  console.log(`   Status: ${release.draft ? 'draft' : 'published'}`);

  // 2. Fetch latest refs
  console.log('\n📦 Fetching git refs...');
  git('fetch --all --prune');

  // 3. Validate all commits before starting
  console.log('\n✅ Validating commits...');
  for (const sha of commits) {
    const title = getCommitTitle(sha);
    console.log(`   ${sha.slice(0, 8)} — ${title}`);
    validateCommit(sha, releaseBranch);
    console.log(`   ✓ on main, not on ${releaseBranch}`);
  }

  if (dryRun) {
    console.log('\n🏁 Dry run — would apply the above commits. Exiting.');
    setOutput('hotfix_branch', `hotfix/${releaseBranch}`);
    setOutput('status', 'dry-run');
    return;
  }

  // 4. Create hotfix branch from the release branch
  console.log('\n🔀 Creating hotfix branch...');
  const hotfixBranch = `hotfix/${releaseBranch}`;

  try {
    git(`push origin --delete ${hotfixBranch}`);
    console.log(`   Cleaned up pre-existing remote branch: ${hotfixBranch}`);
  } catch {
    // Branch doesn't exist remotely — expected for fresh hotfixes
  }

  git(`checkout ${releaseBranch}`);
  git(`checkout -b ${hotfixBranch}`);

  const createdBranches: string[] = [hotfixBranch];
  const conflictPRs: { sha: string; pr: { number: number; html_url: string }; files: string[] }[] = [];
  let needsResolution = false;

  try {
    // 5. Cherry-pick each commit directly onto the hotfix branch
    for (const sha of commits) {
      const title = getCommitTitle(sha);
      console.log(`\n🍒 Cherry-picking: ${title}`);

      git(`checkout ${hotfixBranch}`);
      const clean = tryCherryPick(sha);

      if (clean) {
        console.log(`   ✓ Applied cleanly`);
        continue;
      }

      // -- Conflict path: abort, use a staged branch + PR for resolution --
      console.log(`   ⚠️  Conflict detected`);
      const conflictFiles = getConflictedFiles();
      console.log(`   Conflicted file(s):`);
      for (const f of conflictFiles) console.log(`      - ${f}`);

      git('cherry-pick --abort');

      const stagedBranch = `staged/${sha}/${releaseBranch}`;
      createdBranches.push(stagedBranch);

      try {
        git(`push origin --delete ${stagedBranch}`);
      } catch { /* doesn't exist — expected */ }

      git(`checkout -b ${stagedBranch}`);

      git(`cherry-pick --no-commit ${sha}`);
      git('add -A');
      git(`commit -m "${title}"`);

      git(`push origin ${stagedBranch}`);

      console.log('   📝 Creating PR for conflict resolution...');
      const pr = await createPullRequest(
        stagedBranch,
        hotfixBranch,
        `hotfix(${releaseBranch}): ${title} [CONFLICTS]`,
        [
          `Hotfix cherry-pick for release branch \`${releaseBranch}\``,
          `Original commit: \`${sha}\``,
          `Target: \`${hotfixBranch}\``,
          '',
          '⚠️ **This cherry-pick had merge conflicts.** The conflict markers are committed — please resolve them before merging.',
          '',
          '_PR Generated via Hotfix GitHub Action_',
        ].join('\n')
      );
      console.log(`   PR #${pr.number}: ${pr.html_url}`);

      await addPRComment(pr.number, [
        '## ⚠️ Cherry-pick conflict — manual resolution required',
        '',
        `The cherry-pick of \`${sha}\` onto \`${hotfixBranch}\` produced merge conflicts.`,
        'The conflict markers have been committed so the PR could be created.',
        '',
        '**Conflicted files:**',
        ...conflictFiles.map((f) => `- \`${f}\``),
        '',
        '**To resolve:**',
        '1. Check out this branch locally, or use GitHub\'s web editor',
        '2. Search for `<<<<<<<` conflict markers in the files listed above',
        '3. Resolve each conflict and remove the markers',
        '4. Commit your resolution and **squash merge** the PR',
        '',
        'Once merged, the release dashboard will automatically trigger the release preview.',
      ].join('\n'));

      needsResolution = true;
      conflictPRs.push({ sha, pr, files: conflictFiles });

      console.log(`   ⚠️  PR left open — engineer must resolve conflicts`);
      console.log(`   Remaining commits skipped (resolve this conflict first)`);
      break;
    }

    // Push the hotfix branch with any clean cherry-picks
    git(`push origin ${hotfixBranch}`);

  } catch (err) {
    console.error('\n❌ Hotfix failed:', err);
    setOutput('status', 'failed');

    console.log('\n🧹 Cleaning up branches...');
    await cleanupBranches(createdBranches);

    process.exit(1);
  }

  // 6. Results
  if (needsResolution) {
    console.log('\n⚠️  Hotfix requires manual conflict resolution');
    console.log(`   Branch: ${hotfixBranch}`);
    for (const { sha, pr, files } of conflictPRs) {
      console.log(`   PR #${pr.number} (${sha.slice(0, 8)}): ${pr.html_url}`);
      console.log(`   Conflicted files: ${files.join(', ')}`);
    }

    setOutput('hotfix_branch', hotfixBranch);
    setOutput('status', 'needs-resolution');

    summary('### ⚠️ Hotfix Needs Manual Resolution');
    summary('');
    summary(`**Release:** ${releaseTag}`);
    summary(`**Branch:** \`${hotfixBranch}\``);
    summary('');
    for (const { sha, pr, files } of conflictPRs) {
      summary(`**Conflict:** \`${sha.slice(0, 8)}\` — [PR #${pr.number}](${pr.html_url})`);
      summary(`Files: ${files.map((f) => `\`${f}\``).join(', ')}`);
    }
    summary('');
    summary('Resolve the conflicts in the PR(s) above, merge them, then the release dashboard will auto-trigger release-preview.');
  } else {
    console.log('\n🎉 Hotfix applied successfully!');
    console.log(`   Branch: ${hotfixBranch}`);
    console.log(
      `   Compare: https://github.com/${OWNER}/${REPO}/compare/${releaseBranch}...${hotfixBranch}`
    );

    setOutput('hotfix_branch', hotfixBranch);
    setOutput('status', 'success');

    summary('### 🛠️ Hotfix Applied');
    summary('');
    summary(`**Release:** ${releaseTag}`);
    summary(`**Branch:** \`${hotfixBranch}\``);
    summary(`**Commits:**`);
    for (const sha of commits) {
      const title = getCommitTitle(sha);
      summary(`- \`${sha.slice(0, 8)}\` ${title}`);
    }
    summary('');
    summary(
      `[Compare changes](https://github.com/${OWNER}/${REPO}/compare/${releaseBranch}...${hotfixBranch})`
    );

    if (!skipReleasePreview) {
      console.log('\n🚀 Triggering release-preview workflow...');
      try {
        await dispatchWorkflow('release-preview.yml', hotfixBranch, {
          'test-run': 'false',
          commitish: hotfixBranch,
        });
        console.log('   ✓ Workflow dispatched');
      } catch (err) {
        console.warn(
          '\n⚠️  Could not trigger release-preview automatically:',
          (err as Error).message
        );
        console.log(
          `   You can trigger it manually: https://github.com/${OWNER}/${REPO}/actions/workflows/release-preview.yml`
        );
      }
    } else {
      console.log('\n⏭️  Skipping release-preview (--skip-release-preview)');
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
