import chalk from 'chalk';
import { oraPromise } from 'ora';
import confirm from '@inquirer/confirm';
import input from '@inquirer/input';
import select from '@inquirer/select';
import type { CliOpts } from '../../cli-toolkit';
import { git, github, info, problem, step } from '../../cli-toolkit';

const RECENT_RELEASES_COUNT = 5;
const WEB_APP_RELEASE_NAME_MARKER = 'next-web-app';

export async function hotfixRelease(opts: CliOpts) {
  step('Preparing Repo 📦');
  await checkAndFetchGit();

  step('Fetching Releases 📥');
  const releases = await github.getReleases(RECENT_RELEASES_COUNT);
  if (!releases.length) {
    problem('No releases found. Aborting.');
    process.exit();
  }

  const choiceIndex = await select({
    message: 'Which release do you want to hotfix?',
    choices: releases.map((r, i) => ({
      name: `${r.name} ${
        r.draft ? chalk.gray('(draft)') : chalk.gray('(published)')
      }`,
      value: String(i),
    })),
  });

  const release = releases[Number(choiceIndex)];
  if (!release.name?.includes(WEB_APP_RELEASE_NAME_MARKER)) {
    console.log('');
    console.log(chalk.red.bold('⚠️  WARNING  ⚠️'));
    console.log(
      chalk.red(
        `Release "${release.name}" does not contain "${WEB_APP_RELEASE_NAME_MARKER}".`
      )
    );
    console.log(
      chalk.red(
        'Release Doctor hotfix is hardcoded to trigger a WEB APP release cut (release-preview.yml).'
      )
    );
    console.log('');
    const proceed = await confirm({
      message: 'Continue anyway?',
      default: false,
    });
    if (!proceed) {
      info('Canceled.');
      process.exit();
    }
  }

  await draftHotfixForRelease(release, opts);
}

/**
 * The Core Hotfix Flow (shared for drafts and prod):
 * - Prompts for commit and checks validity
 * - Creates hotfix branch and staging branch for fix
 * - Merges fix into hotfix branch via PR
 * - Kicks off new release cut from hotfix branch
 */
async function draftHotfixForRelease(
  release: github.GithubRelease,
  opts: CliOpts
) {
  const originalBranch = await git.getCurrentBranch();
  const releaseBranch = release.target_commitish;
  const baseBranch = opts.testMode ? originalBranch : releaseBranch;

  info(
    `Hotfixing ${release.draft ? 'Draft' : 'Published'} Release: `,
    chalk.magenta(release.name),
    ` (${chalk.yellow(releaseBranch)})`
  );
  if (opts.testMode) {
    info(chalk.yellow.italic(`⚠️⚠️⚠️ Test mode enabled ⚠️⚠️⚠️`));
    info(
      chalk.yellow.italic(
        `Hotfix will be applied to current branch ${baseBranch}`
      )
    );
    info(
      chalk.yellow.italic(
        `Will run Release Preview in test mode (no release cut or stage deploy)`
      )
    );
  }

  try {
    step('Creating Hotfix Branch 🛠️');
    // Checkout commit
    await git.checkout(baseBranch);

    // create hotfix branch
    const hotfixedBranch = `${
      opts.testMode ? 'test/' : ''
    }hotfix/${baseBranch}`;
    await git.createBranch(hotfixedBranch);
    await git.pushBranch(hotfixedBranch);

    await applyHotfixRecursive({ baseBranch, hotfixedBranch }, opts);

    info('Hotfixes applied successfully: ', chalk.green(hotfixedBranch));
    info(
      'Branch comparison: ',
      chalk.blue.underline(
        `https://github.com/${process.env.GITHUB_OWNER || 'Frameio'}/${process.env.GITHUB_REPO || 'web-app'}/compare/${baseBranch}...${hotfixedBranch}`
      )
    );

    const makeNewCut = await confirm({
      message:
        'Cut a new release from hotfix branch? (does the comparison look right?)',
      default: true,
    });

    if (makeNewCut) {
      step('Cutting New Release 🆕');
      await github.runReleasePreview(hotfixedBranch, opts);
    }

    info(chalk('🎉🎉🎉 Hotfix Flow Completed Successfully 🎉🎉🎉'));

    info(
      chalk.yellow(
        makeNewCut
          ? 'Release Preview will message #ops-releases when job is complete'
          : 'Release Preview not run'
      )
    );
  } catch (e) {
    problem('An error occurred in the hotfix flow:', String(e));
    step('Starting Error Cleanup (recommended before retrying) 🛟');

    // Clean up remote branches on error (on success they will be cleaned by PR merge)
    const remoteBranches = await git.listBranches(baseBranch, true).then(
      (branches) =>
        branches
          .filter(
            (branch) => branch.includes('hotfix/') || branch.includes('staged/')
          )
          .map((b) => b.slice(7)) // remove "origin/"" prefix
    );
    if (remoteBranches.length > 0) {
      info(chalk.yellow('Remote branch artifacts:'));
      remoteBranches.forEach((branch) => info('  - ', branch));
      info(
        chalk.yellow.italic(
          'Note: leaving branches can break hotfix reattempts'
        )
      );
      const deleteRemote = await confirm({
        message: 'Delete these remote branches? (git push origin -d)',
        default: true,
      });
      if (deleteRemote) {
        await oraPromise(
          Promise.all(
            remoteBranches.map((branch) =>
              // warn on error, but these are likely unpruned branches
              git.deleteBranch(branch, true).catch((er) => problem(er.message))
            )
          ),
          {
            text: 'Deleting remote branches',
          }
        );
      }
    }
  }

  step('Cleanup 🧹');

  await git.checkout(originalBranch);

  // Clean up local branches
  const localBranches = await git.listBranches(`/${baseBranch}`, false);
  if (localBranches.length > 0) {
    info(chalk.yellow('Local branch artifacts:'));
    localBranches.forEach((branch) => info('  - ', branch));
    const deleteLocal = await confirm({
      message: 'Delete these local branches? (git branch -D)',
      default: true,
    });
    if (deleteLocal) {
      await oraPromise(
        Promise.all(
          localBranches.map((branch) => git.deleteBranch(branch, false))
        ),
        {
          text: 'Deleting local branches',
        }
      );
    }
  }
}

/**
 * Prompts for commit to apply and checks validity
 * Stages on branch staged/<commit>/<baseBranch>
 * Opens and merges PR into hotfix branch
 * Recursively calls itself to allow multiple commits
 */
async function applyHotfixRecursive(
  {
    baseBranch,
    hotfixedBranch,
  }: { baseBranch: string; hotfixedBranch: string },
  opts: CliOpts
) {
  const hotfixCommit = await promptHotfixCommit(
    opts.testMode ? baseBranch : `origin/${baseBranch}`,
    opts
  );
  step('Cherry Picking Commit Onto Fix Branch 🍒');

  // Commit is valid, attempt to stage on staging branch
  const stagedFixBranch = `${
    opts.testMode ? 'test/' : ''
  }staged/${hotfixCommit}/${baseBranch}`;
  await git.createBranch(stagedFixBranch);
  await git.cherryPick(hotfixCommit);
  await git.pushBranch(stagedFixBranch);

  step('Merging Hotfix To Hotfix Branch 🩹');

  // open pull request: hotfix <-- staging
  const fixTitle = await git.getCommitTitle(hotfixCommit);
  const pr = await github.openPullRequest(hotfixedBranch, stagedFixBranch, {
    title: `hotfix(${baseBranch}):${fixTitle}`, // add title so visible in release notes
    body: `
      Hotfix for release branch ${baseBranch}
      Commit applied: ${hotfixCommit}
      New release target: ${hotfixedBranch}
      PR Generated via Release Doctor CLI
      `,
  });

  // merge pull request
  await github.mergePullRequest(pr.number);

  info(
    `Commit ${chalk.green(hotfixCommit)} staged on`,
    chalk.green(hotfixedBranch)
  );

  const addAdditional = await confirm({
    message: 'Apply additional commits to hotfix?',
    default: false,
  });

  if (addAdditional) {
    // Note additional fixes are applied on top of previous ones so conflicts should
    // arise here during cherry pick and not in the PR
    await applyHotfixRecursive({ baseBranch, hotfixedBranch }, opts);
  }
}

async function checkAndFetchGit() {
  const isGitClean = await git.isGitStateClean();
  if (!isGitClean) {
    info(
      chalk.yellow.bold(
        'Warning: Local git state is not clean. Unstaged/uncommitted changes will not be pushed, but checkouts may conflict.'
      )
    );
    const proceed = await confirm({
      message: 'Continue anyway?',
      default: false,
    });
    if (!proceed) {
      info('Canceled.');
      process.exit();
    }
  }

  // Update git history
  await git.fetch();
}

async function promptHotfixCommit(targetBranch: string, opts: CliOpts) {
  const commit = await input({
    message: `Enter the commit hash for the hotfix (from main - ${chalk.blue.underline(
      `https://github.com/${process.env.GITHUB_OWNER || 'Frameio'}/${process.env.GITHUB_REPO || 'web-app'}/commits/main/`
    )}):`,
    default: undefined,
  });

  if (!commit) {
    problem('No commit provided. Exiting.');
    process.exit();
  }

  try {
    await git.validateHotfixCommit(commit, targetBranch);
  } catch (e) {
    if (opts.testMode) {
      return commit;
    }
    problem(String(e));
    problem('Error validating commit. Provide another or hit enter to exit.');
    return promptHotfixCommit(targetBranch, opts);
  }

  return commit;
}
