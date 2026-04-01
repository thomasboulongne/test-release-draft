import chalk from 'chalk';
import { execSync } from 'child_process';
import ora, { oraPromise } from 'ora';
import confirm from '@inquirer/confirm';
import type { RestEndpointMethodTypes } from '@octokit/rest';
// eslint-disable-next-line import/no-unresolved
import { Octokit } from '@octokit/rest';
import { info, problem } from '../helpers';
import type { CliOpts } from '../types';

const OWNER = process.env.GITHUB_OWNER || 'Frameio';
const REPO = process.env.GITHUB_REPO || 'web-app';

export type GithubRelease =
  RestEndpointMethodTypes['repos']['listReleases']['response']['data'][0];

export type PullRequestDetails = {
  number: number;
  title: string;
  body: string;
  files: Array<{
    filename: string;
    patch?: string;
  }>;
};

// See https://github.com/octokit/plugin-rest-endpoint-methods.js/tree/main/docs for methods
let octokit: Octokit;
async function ghClient() {
  if (!octokit) {
    const token = await getAuthToken();
    octokit = new Octokit({
      auth: token,
    });
  }

  return octokit;
}

export async function runReleasePreview(targetBranch: string, opts: CliOpts) {
  const client = await ghClient();
  await oraPromise(
    client.rest.actions.createWorkflowDispatch({
      owner: OWNER,
      repo: REPO,
      workflow_id: 'release-preview.yml',
      ref: targetBranch,
      inputs: {
        'test-run': String(opts.testMode),
        commitish: targetBranch,
      },
    }),
    {
      text: `Running Release Preview on ${targetBranch}${
        opts.testMode ? ' (TEST MODE)' : ''
      }`,
    }
  );

  // Wait a couple seconds so the run gets fetched
  await oraPromise(new Promise((r) => setTimeout(r, 2000)), {
    text: 'Wait 2 seconds for run to kick off',
  });

  const { data } = await oraPromise(
    client.rest.actions.listWorkflowRuns({
      owner: OWNER,
      repo: REPO,
      workflow_id: 'release-preview.yml',
      branch: targetBranch,
    }),
    {
      text: `Fetching Latest Release Preview run`,
    }
  );

  // should be the most recent
  const run = data.workflow_runs[0];

  if (run) {
    // This can be outdated if targetBranch had old runs
    info('Latest Release Preview Run: ', chalk.blue.underline(run.html_url));
  } else {
    info(
      `Could not find run for ${targetBranch}, try check: `,
      chalk.blue.underline(
        `https://github.com/${OWNER}/${REPO}/actions/workflows/release-preview.yml`
      )
    );
  }

  return run;
}

export async function openPullRequest(
  to: string,
  from: string,
  opts: { title: string; body: string }
) {
  const client = await ghClient();
  const { data } = await oraPromise(
    client.rest.pulls.create({
      owner: OWNER,
      repo: REPO,
      head: from,
      base: to,
      title: opts.title,
      body: opts.body,
    }),
    {
      text: `Opening Pull Request ${from} -> ${to}`,
    }
  );
  chalk.green.bold('Pull Request Created: ', data.html_url);
  return data;
}

export async function mergePullRequest(prNumber: number) {
  const client = await ghClient();
  await oraPromise(
    client.rest.pulls.merge({
      owner: OWNER,
      repo: REPO,
      pull_number: prNumber,
      merge_method: 'squash',
    }),
    {
      text: `Merging Pull Request #${prNumber}`,
    }
  );
}

// Fetches the latest release and any pending drafts
// Installs github cli and logs in if necessary
export async function getReleasesState() {
  const latestReleases = await getReleases(10);

  return {
    draftRelease: latestReleases.filter((r) => r.draft === true),
    lastRelease: latestReleases.find((r) => r.draft === false),
  };
}

export async function getReleases(pageSize: number) {
  const client = await ghClient();
  const { data } = await oraPromise(
    client.rest.repos.listReleases({
      owner: OWNER,
      repo: REPO,
      per_page: pageSize,
    }),
    {
      text: 'Fetching releases',
    }
  );
  return data;
}

// https://github.com/octokit/plugin-rest-endpoint-methods.js/blob/main/docs/repos/updateRelease.md
export async function updateReleaseBody(
  { id, draft, name, tag_name, target_commitish }: GithubRelease,
  body: string
) {
  const client = await ghClient();
  const { data } = await oraPromise(
    client.rest.repos.updateRelease({
      owner: OWNER,
      repo: REPO,
      release_id: id,
      body,
      draft,
      tag_name,
      target_commitish,
    }),
    {
      text: `Updating Release${draft ? ' Draft' : ''} ${name}`,
    }
  );
  return data;
}

export async function compareBranches(
  base: string,
  head: string,
  opts?: { silent?: boolean }
) {
  const client = await ghClient();
  const request = client.rest.repos.compareCommits({
    owner: OWNER,
    repo: REPO,
    base,
    head,
  });
  if (opts?.silent) {
    const { data } = await request;
    return data;
  }
  const { data } = await oraPromise(request, {
    text: `Comparing ${chalk.blue.bold(base)}...${chalk.blue.bold(head)}`,
  });
  return data;
}

// Pull github token from cli, installing and logging in if needed
export async function getAuthToken() {
  const spinner = ora('Initializing github client via GitHub CLI (gh)').start();

  try {
    execSync('which gh'); // errors if no gh cli
  } catch (e) {
    spinner.warn('Github CLI not found');
    const doInstall = await confirm({
      message: 'Install Github CLI? (brew install gh)',
      default: true,
    });
    if (!doInstall) {
      problem('Github CLI required for authorization. Exiting.');
      process.exit();
    }
    spinner.start('Installing Github CLI');
    execSync('brew install gh');
    spinner.succeed();
  }

  try {
    execSync('gh auth status'); // errors if logged out
  } catch (e) {
    spinner.warn('Github CLI not authenticated');
    spinner.start('Logging in with Github CLI');
    execSync('gh auth login', {
      stdio: 'inherit',
    });
    spinner.succeed();
  }

  spinner.stop();

  return execSync('gh auth token').toString();
}

export async function getPullRequest(prNumber: number) {
  const client = await ghClient();

  const [prResponse, filesResponse] = await Promise.all([
    oraPromise(
      client.rest.pulls.get({
        owner: OWNER,
        repo: REPO,
        pull_number: prNumber,
      }),
      {
        text: 'Fetching Pull Request details',
      }
    ),
    oraPromise(
      client.rest.pulls.listFiles({
        owner: OWNER,
        repo: REPO,
        pull_number: prNumber,
      }),
      {
        text: 'Fetching changed files',
      }
    ),
  ]);

  const { data: pr } = prResponse;
  const { data: files } = filesResponse;

  return {
    number: prNumber,
    title: pr.title,
    body: pr.body || '',
    files,
  } as PullRequestDetails;
}

export async function createPullRequestReview(
  prNumber: number,
  comments: Array<{
    path: string;
    line: number;
    body: string;
  }>,
  summary: string
): Promise<unknown> {
  const client = await ghClient();

  return oraPromise(
    client.rest.pulls.createReview({
      owner: OWNER,
      repo: REPO,
      pull_number: prNumber,
      comments,
      body: summary,
      event: 'COMMENT',
    }),
    {
      text: 'Creating Pull Request Review',
    }
  );
}

/* eslint-disable no-continue */
// format file patches for clearer display and readability
export function formatPatchLines(patch: string | undefined): string[] {
  if (!patch) return [];

  // Split by \n and filter out empty lines
  const lines = patch.split('\n').filter((line) => line);

  // Extract starting line number from the @@ pattern
  const lineCtxRegex = /@@ -(\d+),\d+ \+(\d+),\d+ @@(.*)/;

  let beforeLine = 0;
  let afterLine = 0;
  const formattedLines = [];

  // Process each line
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineMatch = line.match(lineCtxRegex);
    if (lineMatch) {
      beforeLine = parseInt(lineMatch[1], 10);
      afterLine = parseInt(lineMatch[2], 10);
      continue;
    }

    // Handle removed lines
    if (line.startsWith('-')) {
      formattedLines.push(`Line ${beforeLine} (removed): ${line.slice(1)}`);
      beforeLine += 1;
      continue;
    }

    // Handle added lines
    if (line.startsWith('+')) {
      formattedLines.push(`Line ${afterLine} (added): ${line.slice(1)}`);
      afterLine += 1;
      continue;
    }

    // Handle context lines (tail ends)
    formattedLines.push(`Line ${beforeLine} --> ${afterLine}: ${line}`);
    beforeLine += 1;
    afterLine += 1;
  }

  return formattedLines;
}
/* eslint-enable no-continue */
