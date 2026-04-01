import chalk from 'chalk';
import checkbox from '@inquirer/checkbox';
import confirm from '@inquirer/confirm';
import input from '@inquirer/input';
import select from '@inquirer/select';
import type { CliOpts, GithubRelease } from '../../cli-toolkit';
import { github, info, problem, pRun, warn } from '../../cli-toolkit';
import { commitsToReleaseNotes } from '../../../scripts/release-draft/draft-release-notes';

const NUM_RELEASES = 20;
const WEB_APP_PREFIX = '@frameio/next-web-app@';
const INTEGRATIONS_PREFIX = '@frameio/next-integrations@';

function getReleasePrefix(release: GithubRelease): string | null {
  const name = release.name ?? '';
  if (name.startsWith(WEB_APP_PREFIX)) return WEB_APP_PREFIX;
  if (name.startsWith(INTEGRATIONS_PREFIX)) return INTEGRATIONS_PREFIX;
  return null;
}

const HOTFIX_COMMIT_THRESHOLD = 3;

function getHotfixSignals(release: GithubRelease): string[] {
  const signals: string[] = [];

  if (release.target_commitish.includes('hotfix/')) {
    signals.push('branch contains hotfix/');
  }
  if (release.tag_name.includes('hotfix')) {
    signals.push('tag contains hotfix');
  }

  const body = release.body ?? '';

  if (/PR Generated via Release Doctor CLI/i.test(body)) {
    signals.push('body mentions Release Doctor');
  }
  if (/hotfix for release branch/i.test(body)) {
    signals.push('body mentions hotfix');
  }
  if (/^\s*\*.*hotfix\(/im.test(body)) {
    signals.push('commit titled hotfix(…)');
  }

  const bulletCount = (body.match(/^\s*\*/gm) || []).length;
  if (bulletCount > 0 && bulletCount <= HOTFIX_COMMIT_THRESHOLD) {
    signals.push(`only ${bulletCount} commit${bulletCount > 1 ? 's' : ''}`);
  }

  return signals;
}

function isHotfixRelease(release: GithubRelease): boolean {
  const signals = getHotfixSignals(release);
  const strongSignal = signals.some(
    (s) => !s.startsWith('only ') // commit count alone is weak
  );
  return strongSignal || signals.length >= 2;
}

function extractBulletTitles(releaseBody: string): string[] {
  return (releaseBody.match(/^\s*\*\s+.+$/gm) || []).map((line) =>
    line.replace(/^\s*\*\s+/, '').trim()
  );
}

type ParsedCommit = {
  authorTag: string;
  title: string;
  body: string;
};

function findHotfixCommitTitles(hotfixReleases: GithubRelease[]): Set<string> {
  const titles = new Set<string>();
  for (const hr of hotfixReleases) {
    for (const bullet of extractBulletTitles(hr.body ?? '')) {
      titles.add(bullet);
    }
  }
  return titles;
}

async function resolveCommitSha(release: GithubRelease): Promise<string> {
  if (/^[0-9a-f]{40}$/i.test(release.target_commitish)) {
    return release.target_commitish;
  }

  const candidates = [
    release.tag_name,
    `${release.tag_name}.0`,
    `origin/${release.target_commitish}`,
  ];

  for (const ref of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await pRun(`git rev-parse "${ref}"`);
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    `Could not resolve commit for release "${release.name}" (tag: ${release.tag_name}, target: ${release.target_commitish})`
  );
}

function formatReleaseName(
  release: GithubRelease,
  options?: { recommended?: boolean }
): string {
  const tags: string[] = [];
  if (release.draft) tags.push(chalk.yellow('draft'));

  const hotfixSignals = getHotfixSignals(release);
  if (isHotfixRelease(release)) {
    tags.push(chalk.red(`hotfix — ${hotfixSignals.join(', ')}`));
  }

  const suffix = tags.length > 0 ? ` (${tags.join(', ')})` : '';
  const marker = options?.recommended ? chalk.green.bold(' ← recommended') : '';
  return `${release.name}${suffix}${marker}`;
}

async function promptHotfixExclusion(
  commits: ParsedCommit[],
  possibleBases: GithubRelease[],
  selectedBase: GithubRelease
): Promise<ParsedCommit[]> {
  const baseIndex = possibleBases.indexOf(selectedBase);
  const inBetween = possibleBases
    .slice(0, baseIndex)
    .filter((r) => isHotfixRelease(r));

  if (inBetween.length === 0) return commits;

  const hotfixTitles = findHotfixCommitTitles(inBetween);
  if (hotfixTitles.size === 0) return commits;

  const matched = commits.filter((c) =>
    [...hotfixTitles].some((ht) => ht.includes(c.title) || c.title.includes(ht))
  );

  if (matched.length === 0) return commits;

  info(
    `Found ${chalk.yellow(
      String(matched.length)
    )} commit(s) already included in ${
      inBetween.length
    } hotfix release(s) between base and target.`
  );

  const toExclude = await checkbox({
    message: chalk.yellow(
      'Deselect any commits you want to KEEP in the release notes:'
    ),
    choices: matched.map((c) => ({
      name: chalk.gray(c.title),
      value: c,
      checked: true,
    })),
  });

  if (toExclude.length === 0) {
    info('Keeping all commits.');
    return commits;
  }

  const excludeSet = new Set(toExclude);
  info(`Excluding ${chalk.yellow(String(excludeSet.size))} hotfix commit(s).`);
  return commits.filter((c) => !excludeSet.has(c));
}

export async function fixReleaseNotes(opts: CliOpts) {
  try {
    await pRun('git fetch', true);

    const releases = await github.getReleases(NUM_RELEASES + 1);

    const release = await select({
      message: chalk.yellow(
        'Which release would you like to fix the notes for?'
      ),
      choices: releases.slice(0, releases.length - 1).map((data) => ({
        name: formatReleaseName(data),
        value: data,
      })),
    });

    const releaseIndex = releases.indexOf(release);
    const allOlder = releases.slice(releaseIndex + 1);

    const releasePrefix = getReleasePrefix(release);
    const possibleBases = releasePrefix
      ? allOlder.filter((r) => r.name?.startsWith(releasePrefix))
      : allOlder;

    if (possibleBases.length === 0) {
      problem('No matching base releases found.');
      return;
    }

    const recommended = possibleBases.find(
      (r) => !r.draft && !isHotfixRelease(r)
    );
    const defaultBase = recommended ?? possibleBases[0];

    const base = await select({
      message: chalk.yellow(
        'Which release should be the base to compare against?'
      ),
      default: defaultBase,
      choices: possibleBases.map((data) => ({
        name: formatReleaseName(data, {
          recommended: data === recommended,
        }),
        value: data,
      })),
    });

    let targetSha = await resolveCommitSha(release);
    let baseSha = await resolveCommitSha(base);

    info(
      `Target: ${chalk.green(release.name)} -> ${chalk.gray(
        targetSha.slice(0, 12)
      )}`
    );
    info(
      `Base:   ${chalk.green(base.name)} -> ${chalk.gray(baseSha.slice(0, 12))}`
    );

    const useShas = await confirm({
      message: chalk.yellow('Use these resolved commits?'),
      default: true,
    });

    if (!useShas) {
      const customTarget = await input({
        message: `Target commit SHA (${chalk.gray(release.name)}):`,
        default: targetSha,
      });
      const customBase = await input({
        message: `Base commit SHA (${chalk.gray(base.name)}):`,
        default: baseSha,
      });
      targetSha = customTarget || targetSha;
      baseSha = customBase || baseSha;
      info(`Using custom target: ${chalk.gray(targetSha.slice(0, 12))}`);
      info(`Using custom base:   ${chalk.gray(baseSha.slice(0, 12))}`);
    }

    const comparison = await github.compareBranches(baseSha, targetSha);

    if (comparison.total_commits > comparison.commits.length) {
      warn(
        `GitHub returned ${comparison.commits.length} of ${comparison.total_commits} commits. ` +
          'Release notes may be incomplete for very large releases.'
      );
    }

    const allCommits: ParsedCommit[] = comparison.commits.map((c) => {
      const titleBreak = c.commit.message.indexOf('\n');
      const title =
        titleBreak === -1
          ? c.commit.message
          : c.commit.message.slice(0, titleBreak);
      const body =
        titleBreak === -1 ? '' : c.commit.message.slice(titleBreak + 1);
      return {
        authorTag: c.author?.login || 'unknown',
        title,
        body,
      };
    });

    const commits = await promptHotfixExclusion(
      allCommits,
      possibleBases,
      base
    );

    const currentNotes = release.body || 'Error fetching release body';
    const updatedDraft = commitsToReleaseNotes(commits);

    const [added, removed] = ezDiff(currentNotes, updatedDraft);

    if (added + removed === 0) {
      info('No changes detected.');
      return;
    }

    info(
      `Lines added: ${chalk.green(String(added))}, removed: ${chalk.red(
        String(removed)
      )}`
    );

    console.log();
    console.log(chalk.cyan.bold('--- Full proposed release notes ---'));
    console.log(updatedDraft);
    console.log(chalk.cyan.bold('--- End of proposed notes ---'));
    console.log();

    if (opts.testMode) {
      info(chalk.yellow('Test mode — skipping release update.'));
      return;
    }

    const apply = await confirm({
      message: chalk.yellow('Apply these changes?'),
      default: true,
    });

    if (!apply) return;

    const updatedRelease = await github.updateReleaseBody(
      release,
      updatedDraft
    );

    info('Updated Release:', updatedRelease.html_url);
  } catch (e) {
    problem('Failed to fix release notes:', String(e));
  }
}

/**
 * Super basic text diff based on sequential line comparison.
 * Used only for a quick summary — the full proposed notes are printed separately.
 */
function ezDiff(before: string, after: string) {
  const lines1 = before
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const lines2 = after
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const changes = [0, 0];
  let r = 0;
  let l = 0;
  while (l < lines1.length || r < lines2.length) {
    const line = lines2[r];
    if (line === lines1[l]) {
      r += 1;
      l += 1;
    } else if (lines1.slice(l).indexOf(line) === -1 && line) {
      console.log('+', chalk.green(line));
      r += 1;
      changes[0] += 1;
    } else {
      console.log('-', chalk.red(lines1[l]));
      l += 1;
      changes[1] += 1;
    }
  }
  return changes;
}
