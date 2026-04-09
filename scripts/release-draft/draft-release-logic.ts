/**
 * Pure logic extracted from draft-release.ts for testability.
 *
 * These functions have no side effects — no network calls, no file I/O,
 * no process.exit. They are used by both the CI entrypoint and the test suite.
 */

export const HOTFIX_COMMIT_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GitHubRelease = {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  target_commitish: string;
};

export type CompareCommit = {
  sha: string;
  commit: { message: string };
  author: { login: string } | null;
};

export type CompareResponse = {
  total_commits: number;
  commits: CompareCommit[];
};

export type Commit = { title: string; body: string; authorTag: string };

// ---------------------------------------------------------------------------
// Hotfix detection (mirrors release-notes.ts logic)
// ---------------------------------------------------------------------------

export function isHotfixRelease(release: GitHubRelease): boolean {
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

export function parseVersion(
  tagName: string,
  prefix: string
): { major: number; minor: number } {
  const versionStr = tagName.slice(prefix.length);
  const [major, minor] = versionStr.split('.').map(Number);
  return { major: major || 0, minor: minor || 0 };
}

export function resolveNextVersion(
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

export function unwrapHotfixTitle(title: string): string {
  return title
    .replace(/^(?:⚠️\s*)?hotfix\(release\/[^)]+\):\s*/i, '')
    .replace(/\s*\[CONFLICTS\]\s*$/i, '')
    .trim();
}

export function isMergePRCommit(title: string): boolean {
  return /^Merge pull request #\d+/i.test(title);
}

export function parseCommits(
  raw: CompareCommit[],
  isHotfix: boolean
): Commit[] {
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

export function extractBulletTitles(releaseBody: string): string[] {
  return (releaseBody.match(/^\s*\*\s+.+$/gm) || []).map((line) =>
    line.replace(/^\s*\*\s+/, '').trim()
  );
}

export function normalizeTitle(title: string): string {
  return title
    .replace(/\s+@\S+\s+\(#\d+\)$/, '')
    .replace(/\s+\(#\d+\)$/, '')
    .replace(/^hotfix\([^)]*\):/, '')
    .replace(/\\[&_]/g, '')
    .trim()
    .toLowerCase();
}

export function excludeHotfixCommits(
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
