/* eslint-disable no-console */
/**
 * Formats a list of parsed commits into categorized markdown release notes.
 *
 * Categorization is based on conventional commit prefixes (feat, fix, chore,
 * etc.) matching the rules previously defined in the release-drafter YAML
 * configs. Each commit line includes Jira ticket links and author attribution.
 *
 * Used by:
 *  - scripts/release-draft/draft-release.ts (CI release drafting)
 *  - dev-ops/release-doctor-cli/src/release-notes.ts (interactive note fixer)
 */

const SECTIONS = [
  {
    title: '🚀 Features',
    filter: labelFilter(['feat', 'feature', 'perf']),
  },
  {
    title: '🏁 Flagged Features (no QA steps necessary)',
    filter: bodyFilter(/\[x\] is this behind a feature flag/g),
  },
  {
    title: '🐛 Bug Fixes',
    filter: labelFilter(['bug', 'bugfix', 'fix']),
  },
  {
    title: '🧰 Maintenance',
    filter: labelFilter([
      'build',
      'chore',
      'ci',
      'docs',
      'refactor',
      'revert',
      'style',
      'test',
    ]),
  },
];

type Commit = {
  title: string;
  body: string;
  authorTag: string;
};

export function commitsToReleaseNotes(commits: Array<Commit>) {
  let draft = '';

  function line(s: string) {
    draft += `${s}\n`;
  }

  if (commits.length === 0) {
    return '* No changes';
  }

  // list unmatched commits first
  commits
    .filter((commit) => {
      return !SECTIONS.some((section) => section.filter(commit));
    })
    .map((unmatchedCommit) => line(`* ${formatCommit(unmatchedCommit)}`));

  SECTIONS.forEach((section) => {
    const matchedCommits = commits.filter(section.filter);

    if (matchedCommits.length > 0) {
      line(`## ${section.title}\n`);

      matchedCommits.reverse().forEach((commit) => {
        line(`* ${formatCommit(commit)}`);
      });

      line('\n'); // end of section
    }
  });

  return draft;
}

export function labelFilter(labels: string[]) {
  return (commit: Commit) => {
    return labels.some((label) => commit.title.toLowerCase().startsWith(label));
  };
}

export function bodyFilter(regex: RegExp) {
  return (commit: Commit) => {
    return regex.test(commit.body);
  };
}

function formatCommit(commit: Commit) {
  return escapeChars(
    linkJira(prependAuthorToPR(commit.title, commit.authorTag))
  );
}

export function escapeChars(s: string): string {
  return s.replaceAll('&', `\\&`).replaceAll('_', `\\_`);
}

// https://github.com/Frameio/web-app/blob/main/.github/release-drafter.yml#L138-L140
export function linkJira(title: string): string {
  const jiraTicketRegex = /([a-zA-Z0-9]+-\d+)/g;

  return title.replace(
    jiraTicketRegex,
    (match) => `[${match}](https://frame-io.atlassian.net/browse/${match})`
  );
}

export function prependAuthorToPR(title: string, author: string) {
  const lastIndex = title.lastIndexOf(' (#');
  if (lastIndex === -1) {
    return `${title} @${author}`;
  }
  return `${title.slice(0, lastIndex)} @${author}${title.slice(lastIndex)}`;
}
