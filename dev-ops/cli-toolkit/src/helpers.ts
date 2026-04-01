import chalk from 'chalk';
import { exec } from 'child_process';
import { oraPromise } from 'ora';

export function info(...args: string[]) {
  console.log(chalk.bgBlueBright.bold(' INFO '), ...args);
}

export function warn(...args: string[]) {
  console.log(chalk.bgYellow.bold(' WARN '), ...args);
}

export function step(...args: string[]) {
  console.log(chalk.bgGreen.bold('    STEP    '), ...args);
}

export function problem(...args: string[]) {
  console.error(chalk.bgRed.bold(' ERROR '), ...args);
}

export function command(...args: string[]) {
  console.log(chalk.bgBlue.bold(' $> '), ...args);
}

// Simple exec promise helper with spinner label
// if info is `true`, use cmd as spinner text
export async function pRun(cmd: string, label?: string | boolean) {
  const p = new Promise<string>((resolve, reject) => {
    exec(cmd, (error, stdout) => {
      if (error) reject(error);
      resolve(stdout.trim());
    });
  });
  if (!label) return p;
  return oraPromise(p, { text: label === true ? cmd : label });
}
