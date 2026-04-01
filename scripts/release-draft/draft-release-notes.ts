/* eslint-disable no-console */
/**
 * Takes a list of commits and outputs a markdown draft of release notes in
 * the style of release-drafter
 *
 * Output:
 * ## <Section>:
 *
 * * <commit w/ jira link> <pr> <author>
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

function labelFilter(labels) {
  return (commit) => {
    return labels.some((label) => commit.title.toLowerCase().startsWith(label));
  };
}

function bodyFilter(regex) {
  return (commit) => {
    return regex.test(commit.body);
  };
}

function formatCommit(commit) {
  return escapeChars(
    linkJira(prependAuthorToPR(commit.title, commit.authorTag))
  );
}

function escapeChars(s) {
  return s.replaceAll('&', `\\&`).replaceAll('_', `\\_`);
}

// https://github.com/Frameio/web-app/blob/main/.github/release-drafter.yml#L138-L140
function linkJira(title: string): string {
  const jiraTicketRegex = /([a-zA-Z0-9]+-\d+)/g;

  return title.replace(
    jiraTicketRegex,
    (match) => `[${match}](https://frame-io.atlassian.net/browse/${match})`
  );
}

function prependAuthorToPR(title: string, author: string) {
  const lastIndex = title.lastIndexOf(' (#');
  return `${title.slice(0, lastIndex)} @${author}${title.slice(lastIndex)}`;
}
