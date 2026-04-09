/**
 * Pure logic extracted from hotfix.ts for testability.
 *
 * These functions have no side effects — no execSync, no fetch, no process.exit.
 */

export type ParsedHotfixArgs = {
  releaseTag: string;
  commits: string[];
  skipReleasePreview: boolean;
  dryRun: boolean;
};

export function parseHotfixArgs(argv: string[]): ParsedHotfixArgs | null {
  let releaseTag = '';
  let commits: string[] = [];
  let skipReleasePreview = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--release-tag' && argv[i + 1]) {
      releaseTag = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--commits' && argv[i + 1]) {
      commits = argv[i + 1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
    } else if (argv[i] === '--skip-release-preview') {
      skipReleasePreview = true;
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    }
  }

  if (!releaseTag || commits.length === 0) {
    return null;
  }

  return { releaseTag, commits, skipReleasePreview, dryRun };
}

export function parseConflictedFiles(porcelainOutput: string): string[] {
  return porcelainOutput
    .split('\n')
    .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(l))
    .map((l) => l.slice(3).trim());
}
