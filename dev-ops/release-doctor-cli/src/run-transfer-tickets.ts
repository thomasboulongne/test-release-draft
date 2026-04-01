/* eslint-disable import/no-relative-packages,import/no-extraneous-dependencies */
import fs from 'fs';
import { oraPromise } from 'ora';
import path from 'path';
import confirm from '@inquirer/confirm';
import input from '@inquirer/input';
import { github } from '../../cli-toolkit';
const transitionLatestReleaseTickets = async (_opts: any) => { throw new Error('Not available in test repo'); };

export default async function transferJiraTickets() {
  const jiraToken = await getJiraToken();
  const jiraEmail = await getJiraEmail();
  const githubToken = await github.getAuthToken();

  await oraPromise(
    transitionLatestReleaseTickets({
      owner: 'frameio',
      repo: 'web-app',
      jiraEmail,
      jiraToken,
      githubToken,
    }),
    {
      text: 'Transferring Jira Tickets',
    }
  );
}

async function getJiraToken() {
  const envToken = process.env.JIRA_TOKEN;
  if (envToken) {
    return envToken;
  }

  const jiraToken = await input({
    message:
      'Script requires Jira Token. Create one at https://id.atlassian.com/manage-profile/security/api-tokens and enter here:',
    default: undefined,
  });

  if (!jiraToken) {
    console.error('Jira token required for Ticket Transfer. Exiting.');
    process.exit();
  }

  const saveToEnv = await confirm({
    message: 'Save token to .env?',
    default: true,
  });

  if (saveToEnv) {
    await saveVarToEnv('JIRA_TOKEN', jiraToken);
  }
  return jiraToken;
}

async function getJiraEmail() {
  const envEmail = process.env.JIRA_EMAIL;
  if (envEmail) {
    return envEmail;
  }

  const jiraEmail = await input({
    message: 'Enter Jira Email associated with token:',
    default: undefined,
  });

  if (!jiraEmail) {
    console.error('Jira email required for Ticket Transfer. Exiting.');
    process.exit();
  }

  const saveToEnv = await confirm({
    message: 'Save email to .env?',
    default: true,
  });

  if (saveToEnv) {
    await saveVarToEnv('JIRA_EMAIL', jiraEmail);
  }
  return jiraEmail;
}

async function saveVarToEnv(varName: string, varValue: string) {
  return oraPromise(
    new Promise<void>((res, rej) => {
      const envPath = path.resolve(__dirname, '../../../.env');

      fs.appendFile(envPath, `\n${varName}=${varValue}\n`, (err) => {
        if (err) rej(err);
        res();
      });
    }),
    {
      text: `Saving ${varName} to .env`,
    }
  );
}
