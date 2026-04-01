import chalk from 'chalk';
import type { GithubRelease } from '../../cli-toolkit';
import { git, github } from '../../cli-toolkit';
const vercel = { getDeployments: async () => ({ deployments: [] as any[] }) } as any;

const WEB_APP_TAG = 'next-web-app';
const INTEGRATIONS_TAG = 'next-integrations';

function byTag(
  releases: GithubRelease[],
  tagContains: string
): GithubRelease[] {
  return releases.filter((r) => r.tag_name.includes(tagContains));
}

function findProdRelease(
  releases: GithubRelease[],
  deployments: Awaited<ReturnType<typeof vercel.listWebAppProdDeployments>>,
  prodInspect: Awaited<ReturnType<typeof vercel.inspectWebAppProd>>
): GithubRelease | undefined {
  const prodDeploy = deployments.deployments.find(
    (d) => d.url === prodInspect.url
  );
  const githubCommitRef = prodDeploy?.meta?.githubCommitRef;
  if (githubCommitRef == null) return undefined;
  return releases.find((r) => !r.draft && r.tag_name === githubCommitRef) as
    | GithubRelease
    | undefined;
}

const MAIN_REF = 'main';

async function getReleaseTargetDetails(release: GithubRelease): Promise<{
  commitHash: string;
  commitTitle: string;
  commitAuthor: string;
  commitDate: string;
}> {
  const ref = /^[0-9a-f]{40}$/i.test(release.target_commitish)
    ? release.target_commitish
    : `origin/${release.target_commitish}`;
  const details = await git.getBranchDetails(ref);
  return {
    ...details,
    commitDate: new Date(details.commitDate).toLocaleString(),
  };
}

async function getCompareCounts(
  baseRef: string,
  headRef: string
): Promise<{ aheadBy: number; behindBy: number } | null> {
  try {
    const data = await github.compareBranches(baseRef, headRef, {
      silent: true,
    });
    return { aheadBy: data.ahead_by, behindBy: data.behind_by };
  } catch {
    return null;
  }
}

async function getRelativeCommitsLine(
  commitRef: string,
  options: {
    latestCommitRef?: string;
    isLatest?: boolean;
    isDraft?: boolean;
  }
): Promise<string> {
  const parts: string[] = [];
  const mainCmp = await getCompareCounts(commitRef, MAIN_REF);
  if (mainCmp) parts.push(`${mainCmp.aheadBy} behind main`);
  if (options.isDraft && options.latestCommitRef) {
    const draftCmp = await getCompareCounts(options.latestCommitRef, commitRef);
    if (draftCmp?.aheadBy) parts.push(`${draftCmp.aheadBy} ahead of latest`);
  }
  if (!options.isLatest && options.latestCommitRef) {
    const prodCmp = await getCompareCounts(commitRef, options.latestCommitRef);
    if (prodCmp?.aheadBy) parts.push(`${prodCmp.aheadBy} behind latest`);
  }
  return parts.length ? parts.join(', ') : '';
}

function formatComponent(
  label: string,
  tagName: string,
  details: {
    target: string;
    commitHash: string;
    commitTitle: string;
    commitAuthor: string;
    commitDate: string;
  },
  status: string = '',
  relativeCommits?: string
): void {
  console.log(chalk.bold(`${label}: ${tagName}`), `${status}`);
  console.log(
    chalk.gray(
      `  ${chalk.bold('Target:')} ${details.target} - ${details.commitHash}`
    )
  );
  console.log(chalk.gray(`  ${chalk.bold('Title:')} ${details.commitTitle}`));
  console.log(chalk.gray(`  ${chalk.bold('Author:')} ${details.commitAuthor}`));
  console.log(chalk.gray(`  ${chalk.bold('Time:')} ${details.commitDate}`));
  if (relativeCommits)
    console.log(chalk.gray(`  ${chalk.bold('Commits:')} ${relativeCommits}`));
}

export default async function inspectReleases() {
  await git.fetch();

  const [
    allReleases,
    webProd,
    webProdDeployments,
    integrationsProd,
    integrationsProdDeployments,
  ] = await Promise.all([
    github.getReleases(20),
    vercel.inspectWebAppProd(),
    vercel.listWebAppProdDeployments(),
    vercel.inspectIntegrationsProd(),
    vercel.listIntegrationsProdDeployments(),
  ]);

  async function printSection(
    title: string,
    tagFilter: string,
    prodUrl: string,
    prodDeployments: typeof webProdDeployments,
    prodInspect: typeof webProd
  ) {
    const releases = byTag(allReleases, tagFilter);
    const published = releases.filter((r) => !r.draft);
    const draftReleases = releases.filter((r) => r.draft);
    const latestRelease = published[0];
    const prodRelease = findProdRelease(releases, prodDeployments, prodInspect);
    const prodIsLatest =
      prodRelease != null &&
      latestRelease != null &&
      prodRelease.tag_name === latestRelease.tag_name;

    const latestDetails = latestRelease
      ? await getReleaseTargetDetails(latestRelease)
      : null;
    const latestCommitRef = latestDetails?.commitHash;

    console.log();
    console.log(chalk.cyan.bold(`——— ${title} ———`));
    console.log();

    if (draftReleases.length > 0) {
      const draft = draftReleases[0];
      const details = await getReleaseTargetDetails(draft);
      const draftRelative = await getRelativeCommitsLine(details.commitHash, {
        latestCommitRef,
        isDraft: true,
      });
      formatComponent(
        chalk.yellow.bold('Draft'),
        draft.tag_name,
        {
          ...details,
          target: draft.target_commitish,
        },
        '',
        draftRelative
      );
    } else {
      console.log(chalk.yellow.bold('Draft: No draft'));
    }

    console.log();

    if (prodRelease) {
      const details = await getReleaseTargetDetails(prodRelease);
      const status = prodIsLatest ? ' (latest ✅ )' : ' (not latest ⚠️ )';
      const prodRelative = await getRelativeCommitsLine(details.commitHash, {
        latestCommitRef,
        isLatest: prodIsLatest,
      });
      formatComponent(
        chalk.blue.bold(`Production - ${prodUrl}`),
        prodRelease.tag_name,
        {
          ...details,
          target: prodRelease.target_commitish,
        },
        status,
        prodRelative
      );
    } else {
      const ref = prodDeployments.deployments.find(
        (d) => d.url === prodInspect.url
      )?.meta?.githubCommitRef;
      console.log(
        chalk.blue.bold(`Production - ${prodUrl}: `),
        ref != null
          ? chalk.yellow(`ref ${ref} (no matching GitHub release)`)
          : chalk.yellow('Could not determine from Vercel')
      );
    }

    if (prodRelease && !prodIsLatest && latestRelease && latestDetails) {
      console.log();
      const latestRelative = await getRelativeCommitsLine(
        latestDetails.commitHash,
        { isLatest: true }
      );
      formatComponent(
        chalk.green.bold('Latest'),
        latestRelease.tag_name,
        {
          ...latestDetails,
          target: latestRelease.target_commitish,
        },
        '',
        latestRelative
      );
    }

    console.log();
  }

  await printSection(
    'Web App 🖥️ ',
    WEB_APP_TAG,
    'next.frame.io',
    webProdDeployments,
    webProd
  );
  await printSection(
    'Integrations 🔌',
    INTEGRATIONS_TAG,
    'integrations.frame.io',
    integrationsProdDeployments,
    integrationsProd
  );
}
