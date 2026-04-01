/* eslint-disable no-console */
import chalk from 'chalk';
import select from '@inquirer/select';
import type { CliOpts } from '../cli-toolkit';
import { hotfixRelease } from './src/hotfix';
import inspectReleases from './src/inspect-releases';
import { fixReleaseNotes } from './src/release-notes';
import transferTickets from './src/run-transfer-tickets';

type Action = {
  name: string;
  description: string;
  action: (opts: CliOpts) => Promise<void>;
};

const ACTIONS: { [key: string]: Action } = {
  inspect: {
    name: 'inspect 🩻',
    description: 'Get information about prod and staged releases',
    action: async (opts) => {
      await inspectReleases();
      return promptAction(opts);
    },
  },
  hotfix: {
    name: 'hotfix web app release 🛠️',
    description:
      'Apply hotfix commit(s) to a release (draft or published), and cut new release',
    action: hotfixRelease,
  },
  notes: {
    name: 'fix draft release notes 📝',
    description:
      'Attempt to fix the release notes for the current release draft',
    action: fixReleaseNotes,
  },
  tickets: {
    name: 'transfer jira tickets 🎟️',
    description: 'Run transfer tickets against latest release',
    action: async () => transferTickets(),
  },
  nothing: {
    name: 'nothing',
    description: 'Exit the CLI',
    action: async () => console.log('exiting...'),
  },
};

(async function main() {
  const cliArgs = process.argv.slice(2);
  const opts: CliOpts = {
    testMode: cliArgs.includes('--test-mode'),
  };

  try {
    console.log(
      `🚑 ${chalk.blue.bold(' Web-App Release Doctor CLI')} 🚑`,
      opts.testMode ? chalk.bgYellowBright.bold(' TEST MODE ENABLED ') : ''
    );
    console.log(divider(['blue', 'yellowBright']));

    await promptAction(opts);
  } catch (e) {
    console.error(e);
  }
})();

async function promptAction(opts: CliOpts) {
  const action = await select({
    message: chalk.magenta('What would you like to do?'),
    default: 'inspect',
    choices: Object.entries(ACTIONS).map(([key, a]) => ({
      name: a.name,
      value: key,
      description: a.description,
    })),
  });

  await ACTIONS[action].action(opts);
}

function divider(colors: Array<typeof chalk.Color>) {
  return Array.from({ length: 33 })
    .map((_, i) => chalk[colors[i % colors.length]]('-'))
    .join('');
}
