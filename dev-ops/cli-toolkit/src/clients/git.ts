import chalk from 'chalk';
import ora, { oraPromise } from 'ora';
import confirm from '@inquirer/confirm';
import select from '@inquirer/select';
import { problem, pRun } from '../helpers';

export async function getBranchDetails(branch: string) {
  const commitHash = await getBranchCommit(branch);
  const [commitAuthor, commitTitle, commitDate] = await Promise.all([
    getCommitAuthor(commitHash),
    getCommitTitle(commitHash),
    getCommitDate(commitHash),
  ]);

  return {
    commitHash,
    commitAuthor,
    commitTitle,
    commitDate,
  };
}

export async function fetch() {
  return pRun('git fetch', true);
}

export async function validateHotfixCommit(
  commit: string,
  targetBranch: string
) {
  // this will also error if the string is not a valid commit hash
  await oraPromise(
    pRun(`git branch -r origin/main --contains ${commit}`).then((match) => {
      if (!match) {
        throw new Error('Commit not found on main');
      }
    }),
    {
      // We ensure commits are on main to avoid rereleasing a broken state
      text: 'Verifying commit is on main',
    }
  );

  await oraPromise(
    pRun(`git branch -r ${targetBranch} --contains ${commit}`).then((match) => {
      if (match) {
        throw new Error(`Target commit already exists on ${targetBranch}`);
      }
    }),
    {
      text: 'Verifying commit is not already on target branch',
    }
  );

  const [commitAuthor, commitTitle, commitDate] = await Promise.all([
    getCommitAuthor(commit),
    getCommitTitle(commit),
    getCommitDate(commit),
  ]);

  console.log(chalk.green.bold('Target Commit: '), commitTitle);
  console.log(chalk.green.bold('  Author: '), commitAuthor);
  console.log(chalk.green.bold('  Date: '), commitDate);

  const isCorrect = await confirm({
    message: chalk.yellow.bold('Is this the commit you want to apply?'),
    default: true,
  });

  if (!isCorrect) {
    throw new Error('Commit rejected.');
  }
}

export async function checkout(ref: string) {
  return pRun(`git checkout ${ref}`, true);
}

export async function getCurrentBranch() {
  return pRun('git rev-parse --abbrev-ref HEAD');
}

export async function isGitStateClean() {
  const output = await pRun('git status -s', true).then(
    (res) => res.trim() === ''
  );
  return !!output;
}

export async function listBranches(match: string, remote: boolean) {
  return pRun(
    `git branch --list '*${match}*' ${remote ? ' -r' : ''}`,
    true
  ).then((output) =>
    output
      .split('\n')
      .map((s) => s.replace('*', '').trim())
      .filter(Boolean)
  );
}

export async function createBranch(branch: string) {
  return pRun(`git checkout -b ${branch}`, true);
}

export async function pushBranch(branch: string) {
  return pRun(`git push origin ${branch}`, true);
}

export async function deleteBranch(branch: string, remote: boolean) {
  return pRun(`git ${remote ? 'push origin -d' : 'branch -D'} ${branch}`, true);
}

export async function cherryPick(commit: string) {
  return pRun(`git cherry-pick ${commit}`, true).catch((err) =>
    resolveCherryPickRecursive(commit, err)
  );
}

async function resolveCherryPickRecursive(commit: string, err: Error) {
  problem('cherry-pick error:', String(err));
  const choice = await select({
    message: chalk.yellow(
      'If you can resolve the issue you may choose how to proceed (tip: if unsure, run "git status"):'
    ),
    default: 'verify',
    choices: [
      {
        name: 'Verify and proceed 🚀',
        value: 'verify',
        description:
          'Issue is now resolved (by you), check commit is applied and then proceed',
      },
      {
        name: 'Continue cherry-pick 🍒➡️',
        value: 'continue',
        description: 'git cherry-pick --continue',
      },
      {
        name: 'Retry cherry-pick 🍒🔁',
        value: 'retry',
        description: `git cherry-pick ${commit}`,
      },
      {
        name: 'Ignore error and proceed 🤷',
        value: 'ignore',
        description: `"I know what I'm doing"`,
      },
      {
        name: 'Cancel',
        value: 'cancel',
        description: `abort hotfix`,
      },
    ],
  });

  if (choice === 'cancel') {
    throw new Error('Cherry pick canceled');
  }

  if (choice === 'ignore') {
    return;
  }

  try {
    switch (choice) {
      case 'continue':
        await pRun('git cherry-pick --continue', true);
        break;
      case 'retry':
        await cherryPick(commit);
        break;
      case 'verify':
      default:
        await verifyCherryPick(commit);
        break;
    }
  } catch (e) {
    await resolveCherryPickRecursive(commit, new Error(String(e)));
  }
}

async function verifyCherryPick(commit: string) {
  const spinner = ora('Checking cherry-pick status').start();

  const isClean = await isGitStateClean();
  if (!isClean) {
    spinner.fail();
    throw new Error(`Local git state is not clean. Run 'git status' for info.`);
  }

  const targetCommitTitle = await getCommitTitle(commit);
  const topCommitTitle = await pRun(`git --no-pager log -1 --pretty=%s`);

  // Cherry picked commits are a new commit but will have same title
  if (targetCommitTitle !== topCommitTitle) {
    spinner.fail();
    throw new Error(`Head commit title does not match cherry pick target.`);
  }

  spinner.succeed();
}

async function getBranchCommit(branch: string) {
  return pRun(`git rev-parse ${branch}`);
}

export async function getCommitTitle(commitHash: string) {
  return pRun(`git show -s --format=%s ${commitHash}`);
}

async function getCommitAuthor(commitHash: string) {
  return pRun(`git show -s --format=%an ${commitHash}`);
}

async function getCommitDate(commitHash: string) {
  return pRun(`git show -s --format=%ci ${commitHash}`);
}

export async function status() {
  return pRun(`git status`, true);
}

export async function diffClean() {
  return pRun(`git diff -- . ':(exclude)yarn.lock'`, true);
}

export async function diffSinceMainClean() {
  return pRun(
    `git diff $(git merge-base @ origin/main) ':(exclude)yarn.lock'`,
    true
  );
}

export async function untrackedFiles() {
  return pRun(`git ls-files --others --exclude-standard`, true);
}

export async function listRepoFiles(pattern?: string) {
  // "--full-name :/" ensures run from root of repo
  return pRun(
    `git ls-files --full-name :/ | { grep -E "${pattern || '.*'}" || true; }`,
    true
  );
}
