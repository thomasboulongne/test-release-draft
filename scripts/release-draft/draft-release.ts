/* eslint-disable no-console */
/**
 * Headless release draft script that replaces release-drafter.
 *
 * Key improvement: when the most recent published release is a hotfix,
 * this script looks past it to the correct non-hotfix base, so the
 * draft includes all commits and computes the right version number.
 *
 * Usage (CI):
 *   node scripts/release-draft/draft-release.ts \
 *     --prefix "@frameio/next-web-app@" \
 *     --commitish "release/2026-03-31"
 *
 * Env:
 *   GITHUB_TOKEN  — required
 *   GITHUB_OUTPUT — set by Actions; tag_name is written here
 */

import { appendFileSync } from 'fs';
import { commitsToReleaseNotes } from './draft-release-notes';

const OWNER = process.env.GITHUB_OWNER || 'Frameio';
const REPO = process.env.GITHUB_REPO || 'web-app';
const HOTFIX_COMMIT_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let prefix = '';
  let commitish = '';
  let dryRun = false;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--prefix' && args[i + 1]) {
      prefix = args[i + 1];
      i += 1;
    } else if (args[i] === '--commitish' && args[i + 1]) {
      commitish = args[i + 1];
      i += 1;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  if (!prefix || !commitish) {
    console.error(
      'Usage: --prefix <tag-prefix> --commitish <branch> [--dry-run]'
    );
    process.exit(1);
  }

  return { prefix, commitish, dryRun };
}

// ---------------------------------------------------------------------------
// GitHub API helpers (native fetch, no dependencies)
// ---------------------------------------------------------------------------

type GitHubRelease = {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  target_commitish: string;
};

type CompareCommit = {
  sha: string;
  commit: { message: string };
  author: { login: string } | null;
};

type CompareResponse = {
  total_commits: number;
  commits: CompareCommit[];
};

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('GITHUB_TOKEN environment variable is required');
    process.exit(1);
  }
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...githubHeaders(), ...init?.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function getReleases(perPage: number): Promise<GitHubRelease[]> {
  return fetchJSON<GitHubRelease[]>(`${API}/releases?per_page=${perPage}`);
}

async function compareCommits(
  base: string,
  head: string
): Promise<CompareResponse> {
  return fetchJSON<CompareResponse>(
    `${API}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  );
}

async function findExistingDraft(
  releases: GitHubRelease[],
  prefix: string
): Promise<GitHubRelease | undefined> {
  return releases.find((r) => r.draft && r.tag_name.startsWith(prefix));
}

async function createDraftRelease(opts: {
  tagName: string;
  name: string;
  body: string;
  commitish: string;
}): Promise<GitHubRelease> {
  return fetchJSON<GitHubRelease>(`${API}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: opts.tagName,
      name: opts.name,
      body: opts.body,
      target_commitish: opts.commitish,
      draft: true,
    }),
  });
}

async function updateDraftRelease(
  releaseId: number,
  opts: { tagName: string; name: string; body: string; commitish: string }
): Promise<GitHubRelease> {
  return fetchJSON<GitHubRelease>(`${API}/releases/${releaseId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      tag_name: opts.tagName,
      name: opts.name,
      body: opts.body,
      target_commitish: opts.commitish,
      draft: true,
    }),
  });
}

// ---------------------------------------------------------------------------
// Hotfix detection (mirrors release-notes.ts logic)
// ---------------------------------------------------------------------------

function isHotfixRelease(release: GitHubRelease): boolean {
  const signals: string[] = [];

  if (release.target_commitish.includes('hotfix/')) signals.push('branch');
  if (release.tag_name.includes('hotfix')) signals.push('tag');

  const body = release.body ?? '';
  if (/PR Generated via Release Doctor CLI/i.test(body))
    signals.push('body-doctor');
  if (/hotfix for release branch/i.test(body)) signals.push('body-hotfix');
  if (/Hotfix GitHub Action/i.test(body)) signals.push('body-action');

  const bulletCount = (body.match(/^\s*\*/gm) || []).length;
  if (bulletCount > 0 && bulletCount <= HOTFIX_COMMIT_THRESHOLD) {
    signals.push('low-commits');
  }

  // 'branch' and 'tag' are definitive signals
  // 'body-doctor', 'body-hotfix', 'body-action' are strong contextual signals
  // 'low-commits' alone is weak — needs a second signal
  // bullet content (hotfix(...) in titles) is NOT a signal because normal
  // releases can include hotfix-titled commits that landed on main
  const strongSignal = signals.some(
    (s) =>
      s === 'branch' ||
      s === 'tag' ||
      s === 'body-doctor' ||
      s === 'body-hotfix' ||
      s === 'body-action'
  );
  return strongSignal || signals.length >= 2;
}

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

function parseVersion(
  tagName: string,
  prefix: string
): { major: number; minor: number } {
  const versionStr = tagName.slice(prefix.length);
  const [major, minor] = versionStr.split('.').map(Number);
  return { major: major || 0, minor: minor || 0 };
}

type Commit = { title: string; body: string; authorTag: string };

function resolveNextVersion(
  allPrefixReleases: GitHubRelease[],
  prefix: string,
  commits: Commit[],
  isHotfix: boolean,
  baseRelease?: GitHubRelease
): string {
  const publishedReleases = allPrefixReleases.filter((r) => !r.draft);
  const versions = publishedReleases.map((r) =>
    parseVersion(r.tag_name, prefix)
  );
  const highestMajor = versions.reduce((max, v) => Math.max(max, v.major), 0);

  if (isHotfix && baseRelease) {
    const baseMajor = parseVersion(baseRelease.tag_name, prefix).major;
    const highestMinor = versions
      .filter((v) => v.major === baseMajor)
      .reduce((max, v) => Math.max(max, v.minor), 0);
    return `${baseMajor}.${highestMinor + 1}`;
  }

  return `${highestMajor + 1}.0`;
}

// ---------------------------------------------------------------------------
// Commit parsing
// ---------------------------------------------------------------------------

/**
 * Strip the `hotfix(release/...): ` wrapper that squash-merge commits from
 * the conflict-resolution PR path carry.  Also strips `[CONFLICTS]` suffix.
 */
function unwrapHotfixTitle(title: string): string {
  return title
    .replace(/^(?:⚠️\s*)?hotfix\(release\/[^)]+\):\s*/i, '')
    .replace(/\s*\[CONFLICTS\]\s*$/i, '')
    .trim();
}

function isMergePRCommit(title: string): boolean {
  return /^Merge pull request #\d+/i.test(title);
}

function parseCommits(raw: CompareCommit[], isHotfix: boolean): Commit[] {
  return raw.reduce<Commit[]>((acc, c) => {
    const titleBreak = c.commit.message.indexOf('\n');
    let title =
      titleBreak === -1
        ? c.commit.message
        : c.commit.message.slice(0, titleBreak);
    const body =
      titleBreak === -1 ? '' : c.commit.message.slice(titleBreak + 1);

    if (isHotfix) {
      if (isMergePRCommit(title)) return acc;
      title = unwrapHotfixTitle(title);
    }

    acc.push({
      authorTag: c.author?.login || 'unknown',
      title,
      body,
    });
    return acc;
  }, []);
}

// ---------------------------------------------------------------------------
// Hotfix commit filtering
// ---------------------------------------------------------------------------

function extractBulletTitles(releaseBody: string): string[] {
  return (releaseBody.match(/^\s*\*\s+.+$/gm) || []).map((line) =>
    line.replace(/^\s*\*\s+/, '').trim()
  );
}

/**
 * Strips trailing ` @author (#N)` or ` (#N)` and leading `hotfix(...):` wrapper
 * to get the core commit description for fuzzy matching.
 */
function normalizeTitle(title: string): string {
  return title
    .replace(/\s+@\S+\s+\(#\d+\)$/, '')
    .replace(/\s+\(#\d+\)$/, '')
    .replace(/^hotfix\([^)]*\):/, '')
    .replace(/\\[&_]/g, '')
    .trim()
    .toLowerCase();
}

function excludeHotfixCommits(
  commits: Commit[],
  hotfixReleases: GitHubRelease[]
): Commit[] {
  if (hotfixReleases.length === 0) return commits;

  const normalizedHotfixTitles = new Set<string>();
  for (const hr of hotfixReleases) {
    for (const bullet of extractBulletTitles(hr.body ?? '')) {
      normalizedHotfixTitles.add(normalizeTitle(bullet));
    }
  }

  if (normalizedHotfixTitles.size === 0) return commits;

  return commits.filter(
    (c) => !normalizedHotfixTitles.has(normalizeTitle(c.title))
  );
}

// ---------------------------------------------------------------------------
// Output helper (writes to $GITHUB_OUTPUT in CI)
// ---------------------------------------------------------------------------

function setOutput(key: string, value: string) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
  console.log(`Output: ${key}=${value}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { prefix, commitish, dryRun } = parseArgs();

  console.log(`Draft release for prefix="${prefix}" commitish="${commitish}"`);

  const releases = await getReleases(30);
  const prefixReleases = releases.filter((r) => r.tag_name.startsWith(prefix));
  const published = prefixReleases.filter((r) => !r.draft);

  // Detect if this is a hotfix branch and find the appropriate base
  const isHotfixBranch = commitish.startsWith('hotfix/');
  let baseRelease: GitHubRelease | undefined;
  let hotfixesBetween: GitHubRelease[] = [];

  if (isHotfixBranch) {
    // For hotfix branches (hotfix/release/YYYY-MM-DD-HH-MM), the base is the
    // release targeting the original release branch
    const releaseBranch = commitish.replace(/^hotfix\//, '');
    console.log(
      `Hotfix detected — looking for release targeting ${releaseBranch}`
    );
    baseRelease = published.find(
      (r) => r.target_commitish === releaseBranch && !isHotfixRelease(r)
    );
    if (!baseRelease) {
      baseRelease = published.find((r) => r.target_commitish === releaseBranch);
    }
  }

  if (!baseRelease) {
    // Standard flow: most recent published non-hotfix release
    baseRelease = published.find((r) => !isHotfixRelease(r));
    hotfixesBetween = baseRelease
      ? published
          .slice(0, published.indexOf(baseRelease))
          .filter(isHotfixRelease)
      : [];
  }

  if (!baseRelease) {
    console.error(
      `No published non-hotfix release found for prefix "${prefix}"`
    );
    process.exit(1);
  }

  console.log(
    `Base release: ${baseRelease.tag_name} (${baseRelease.target_commitish})`
  );

  if (hotfixesBetween.length > 0) {
    console.log(
      `Skipping ${hotfixesBetween.length} hotfix release(s): ${hotfixesBetween
        .map((r) => r.tag_name)
        .join(', ')}`
    );
  }

  // For hotfix branches, compare against the release branch (not the tag)
  // to get only the cherry-picked commits
  const compareBase = isHotfixBranch
    ? baseRelease.target_commitish
    : baseRelease.tag_name;
  const comparison = await compareCommits(compareBase, commitish);
  console.log(
    `Found ${comparison.total_commits} commits (${comparison.commits.length} returned by API)`
  );

  if (comparison.total_commits > comparison.commits.length) {
    console.warn(
      `⚠️  GitHub returned ${comparison.commits.length} of ${comparison.total_commits} commits. Notes may be incomplete.`
    );
  }

  // Parse and filter
  const allCommits = parseCommits(comparison.commits, isHotfixBranch);

  const commits = excludeHotfixCommits(allCommits, hotfixesBetween);

  if (commits.length < allCommits.length) {
    console.log(
      `Excluded ${
        allCommits.length - commits.length
      } commit(s) already in hotfix releases`
    );
  }

  // Compute version and generate notes
  const nextVersion = resolveNextVersion(
    prefixReleases,
    prefix,
    commits,
    isHotfixBranch,
    baseRelease
  );
  const tagName = `${prefix}${nextVersion}`;
  const releaseName = tagName;
  const releaseBody = commitsToReleaseNotes(commits);

  console.log(`Next version: ${nextVersion} (tag: ${tagName})`);

  if (dryRun) {
    console.log('\n--- DRY RUN — Release notes preview ---');
    console.log(releaseBody);
    console.log('--- End preview ---\n');
    setOutput('tag_name', tagName);
    return;
  }

  // Create or update draft
  const existingDraft = await findExistingDraft(prefixReleases, prefix);
  const payload = { tagName, name: releaseName, body: releaseBody, commitish };

  let draft: GitHubRelease;
  if (existingDraft) {
    console.log(
      `Updating existing draft: ${existingDraft.tag_name} -> ${tagName}`
    );
    draft = await updateDraftRelease(existingDraft.id, payload);
  } else {
    console.log(`Creating new draft: ${tagName}`);
    draft = await createDraftRelease(payload);
  }

  console.log(`✅ Draft release ready: ${tagName}`);
  setOutput('tag_name', draft.tag_name);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
