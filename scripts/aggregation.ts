import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { paginateGraphQL } from "@octokit/plugin-paginate-graphql";
import { retry } from "@octokit/plugin-retry";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import pc from "picocolors";
import type { Organisation, Repository, Stats } from "../src/types.ts";
import { TerminalDashboard } from "./utils/terminal.ts";
import { CONCURRENCY_LIMIT, MIN_STARS_THRESHOLD } from "./utils/consts.ts";

const OctokitWithPlugins = Octokit.plugin(paginateRest, paginateGraphQL, retry);
const ORGS_DIR = resolve("./data/organisations");
const REPOS_DIR = resolve("./data/repositories");

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error(pc.red("✖ Error: GITHUB_TOKEN environment variable is required."));
  process.exit(1);
}

const octokit = new OctokitWithPlugins({ auth: token });

const readJson = async <T>(filePath: string): Promise<T> => {
  const data = await readFile(filePath, "utf-8");
  return JSON.parse(data) as T;
};

const writeJson = async <T>(filePath: string, data: T): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
};

const sortObjectKeys = <T extends Record<string, any>>(obj: T): T => {
  return Object.keys(obj)
    .sort()
    .reduce((sorted, key) => {
      sorted[key as keyof T] = obj[key];
      return sorted;
    }, {} as T);
};

const getRepoColor = (repoName: string) => {
  const colors = [pc.red, pc.green, pc.yellow, pc.blue, pc.magenta, pc.cyan];
  let hash = 0;
  for (let i = 0; i < repoName.length; i++) {
    hash = repoName.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

class Mutex {
  private promise = Promise.resolve();

  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((res) => (release = res));
    const wait = this.promise;
    this.promise = this.promise.then(() => next);
    await wait;
    return release;
  }
}

async function executeConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T, workerIndex: number) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: limit }, async (_, workerIndex) => {
    while (index < items.length) {
      const currentIndex = index++;
      await fn(items[currentIndex], workerIndex);
    }
  });
  await Promise.all(workers);
}

interface Repo {
  name: string;
  private: boolean;
  updated_at: string;
  stargazers_count: number;
}

interface IssueItem {
  number: number;
  user: {
    login: string;
    type: string;
  } | null;
  reactions?: {
    total_count: number;
  };
}

interface GraphQLPullRequestNode {
  number: number;
  author: {
    login: string;
    __typename: string;
  } | null;
  merged: boolean;
  closingIssuesReferences: {
    totalCount: number;
  };
  reactions: {
    totalCount: number;
  };
  reviews: {
    nodes: Array<{
      state: string;
      author: {
        login: string;
        __typename: string;
      } | null;
    } | null>;
  };
}

interface GraphQLResponse {
  repository: {
    pullRequests: {
      nodes: Array<GraphQLPullRequestNode | null>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
}

const main = async (): Promise<void> => {
  const orgName = process.argv[2];
  if (!orgName) {
    console.error(
      pc.red("✖ Error: Organization name argument is required. Usage: pnpm aggregation <orgName>"),
    );
    process.exit(1);
  }

  const orgFilePath = join(ORGS_DIR, `${orgName}.json`);
  let orgEntry: Organisation;
  try {
    orgEntry = await readJson<Organisation>(orgFilePath);
  } catch (error) {
    console.error(
      pc.red(`✖ Error: Could not read organisation file for '${orgName}' at ${orgFilePath}.`),
      error,
    );
    process.exit(1);
  }

  const orgReposDir = join(REPOS_DIR, orgName);
  await mkdir(orgReposDir, { recursive: true });

  console.log(pc.blue(`▶ Fetching repositories for ${orgName}...`));
  const repos = (await octokit.paginate("GET /orgs/{org}/repos", {
    org: orgName,
    type: "sources",
    per_page: 100,
  })) as Repo[];

  const publicRepos = repos.filter(
    (repo) => !repo.private && repo.stargazers_count >= MIN_STARS_THRESHOLD,
  );
  console.log(
    pc.green(
      `✔ Found ${publicRepos.length} public source repositories (>= ${MIN_STARS_THRESHOLD} stars) for ${orgName}. Starting threads...`,
    ),
  );

  const orgMutex = new Mutex();
  const dashboard = new TerminalDashboard(
    Math.min(CONCURRENCY_LIMIT, publicRepos.length),
    publicRepos.length,
  );

  await executeConcurrent(publicRepos, CONCURRENCY_LIMIT, async (repo, workerIndex) => {
    const repoName = repo.name;
    const colorize = getRepoColor(repoName);
    const repoFilePath = join(orgReposDir, `${repoName}.json`);

    dashboard.updateWorker(workerIndex, repoName, pc.gray("Initializing..."), colorize);

    let repoEntry: Repository;
    try {
      repoEntry = await readJson<Repository>(repoFilePath);
    } catch {
      repoEntry = {
        id: `${orgName}/${repoName}`,
        createdAt: new Date().toISOString(),
        updatedAt: null,
        stats: {},
      };
    }

    const repoUpdatedAt = new Date(repo.updated_at).getTime();
    const lastCrawledAt = repoEntry.updatedAt ? new Date(repoEntry.updatedAt).getTime() : 0;

    if (repoEntry.updatedAt && repoUpdatedAt <= lastCrawledAt) {
      dashboard.updateWorker(
        workerIndex,
        repoName,
        pc.gray("No changes since last crawl. Skipping."),
        colorize,
      );
      dashboard.incrementCompleted();
      return;
    }

    const newStats: Record<string, Omit<Stats, "score">> = {};
    dashboard.updateWorker(workerIndex, repoName, pc.blue("Fetching issues/PR stubs..."), colorize);

    const issues = (await octokit.paginate("GET /repos/{owner}/{repo}/issues", {
      owner: orgName,
      repo: repoName,
      per_page: 100,
      state: "all",
    })) as IssueItem[];

    dashboard.updateWorker(
      workerIndex,
      repoName,
      pc.cyan(`Loaded ${issues.length} basic stubs. Resolving GraphQL PRs...`),
      colorize,
    );

    for (const issue of issues) {
      if (!issue.user || issue.user.type === "Bot") continue;
      const login = issue.user.login;

      if (!newStats[login]) {
        newStats[login] = {
          mergedPrs: 0,
          reviews: 0,
          reviewsReceived: 0,
          issuesLinked: 0,
          reactions: 0,
        };
      }

      if (issue.reactions && issue.reactions.total_count) {
        newStats[login].reactions += issue.reactions.total_count;
      }
    }

    let hasNextPage = true;
    let cursor: string | null = null;
    const pullRequests: GraphQLPullRequestNode[] = [];

    while (hasNextPage) {
      const response: GraphQLResponse = await octokit.graphql(
        `
        query($org: String!, $repo: String!, $cursor: String) {
          repository(owner: $org, name: $repo) {
            pullRequests(first: 100, after: $cursor, states: [MERGED, CLOSED, OPEN]) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                number
                author {
                  login
                  __typename
                }
                merged
                closingIssuesReferences(first: 100) { totalCount }
                reactions { totalCount }
                reviews(first: 100) {
                  nodes {
                    state
                    author {
                      login
                      __typename
                    }
                  }
                }
              }
            }
          }
        }
        `,
        { org: orgName, repo: repoName, cursor },
      );

      const prConnection = response.repository.pullRequests;
      hasNextPage = prConnection.pageInfo.hasNextPage;
      cursor = prConnection.pageInfo.endCursor;

      const validNodes = prConnection.nodes.filter(
        (node): node is GraphQLPullRequestNode => node !== null,
      );
      pullRequests.push(...validNodes);

      dashboard.updateWorker(
        workerIndex,
        repoName,
        pc.magenta(`Batch fetched... Total PRs: ${pullRequests.length}`),
        colorize,
      );
    }

    dashboard.updateWorker(workerIndex, repoName, pc.blue("Aggregating stats..."), colorize);

    for (const pr of pullRequests) {
      const authorLogin = pr.author?.login;
      const isHumanAuthor = authorLogin && pr.author?.__typename !== "Bot";

      if (isHumanAuthor) {
        if (!newStats[authorLogin]) {
          newStats[authorLogin] = {
            mergedPrs: 0,
            reviews: 0,
            reviewsReceived: 0,
            issuesLinked: 0,
            reactions: 0,
          };
        }
        if (pr.reactions && pr.reactions.totalCount) {
          newStats[authorLogin].reactions += pr.reactions.totalCount;
        }
      }

      if (pr.merged) {
        if (isHumanAuthor) {
          newStats[authorLogin].mergedPrs += 1;
          if (pr.closingIssuesReferences && pr.closingIssuesReferences.totalCount) {
            newStats[authorLogin].issuesLinked += pr.closingIssuesReferences.totalCount;
          }
        }

        if (pr.reviews && pr.reviews.nodes) {
          const reviewersForThisPr = new Set<string>();
          let approvalCount = 0;

          for (const review of pr.reviews.nodes) {
            if (!review || !review.author || review.author.__typename === "Bot") continue;
            const reviewerLogin = review.author.login;

            if (
              review.state === "APPROVED" ||
              review.state === "CHANGES_REQUESTED" ||
              review.state === "COMMENTED"
            ) {
              reviewersForThisPr.add(reviewerLogin);
            }

            if (review.state === "APPROVED") {
              approvalCount += 1;
            }
          }

          for (const reviewerLogin of reviewersForThisPr) {
            if (!newStats[reviewerLogin]) {
              newStats[reviewerLogin] = {
                mergedPrs: 0,
                reviews: 0,
                reviewsReceived: 0,
                issuesLinked: 0,
                reactions: 0,
              };
            }
            newStats[reviewerLogin].reviews += 1;
          }

          if (isHumanAuthor) {
            newStats[authorLogin].reviewsReceived += approvalCount;
          }
        }
      }
    }

    const sortedNewStats = sortObjectKeys(newStats);

    if (JSON.stringify(repoEntry.stats) === JSON.stringify(sortedNewStats)) {
      dashboard.updateWorker(
        workerIndex,
        repoName,
        pc.gray("Stats unchanged. Skipping write to preserve updatedAt."),
        colorize,
      );
      dashboard.incrementCompleted();
      return;
    }

    repoEntry.stats = sortedNewStats;
    repoEntry.updatedAt = new Date().toISOString();
    await writeJson<Repository>(repoFilePath, repoEntry);

    dashboard.updateWorker(
      workerIndex,
      repoName,
      pc.yellow("Waiting for lock to update org stats..."),
      colorize,
    );

    const release = await orgMutex.lock();
    try {
      dashboard.updateWorker(workerIndex, repoName, pc.blue("Syncing org checkpoint..."), colorize);

      const repoFiles = await readFileList(orgReposDir);
      const combinedOrgStats: Record<string, Omit<Stats, "score">> = {};

      for (const file of repoFiles) {
        if (!file.endsWith(".json")) continue;
        const targetFilePath = join(orgReposDir, file);
        try {
          const rData = await readJson<Repository>(targetFilePath);

          for (const [username, stats] of Object.entries(rData.stats)) {
            if (!combinedOrgStats[username]) {
              combinedOrgStats[username] = {
                mergedPrs: 0,
                reviews: 0,
                reviewsReceived: 0,
                issuesLinked: 0,
                reactions: 0,
              };
            }
            combinedOrgStats[username].mergedPrs += stats.mergedPrs;
            combinedOrgStats[username].reviews += stats.reviews;
            combinedOrgStats[username].reviewsReceived += stats.reviewsReceived;
            combinedOrgStats[username].issuesLinked += stats.issuesLinked;
            combinedOrgStats[username].reactions += stats.reactions;
          }
        } catch {
          dashboard.logMessage(
            pc.yellow(`⚠ Warning: Found corrupted repo file at ${targetFilePath}. Removing it.`),
          );
          try {
            await rm(targetFilePath);
          } catch {
            dashboard.logMessage(
              pc.red(`✖ Error: Failed to remove corrupted file ${targetFilePath}`),
            );
          }
        }
      }

      const orgData = await readJson<Organisation>(orgFilePath);
      const sortedOrgStats = sortObjectKeys(combinedOrgStats);

      if (JSON.stringify(orgData.stats) !== JSON.stringify(sortedOrgStats)) {
        orgData.stats = sortedOrgStats;
        orgData.updatedAt = new Date().toISOString();
        await writeJson<Organisation>(orgFilePath, orgData);
      }

      dashboard.updateWorker(workerIndex, repoName, pc.green("✔ Done."), colorize);
    } finally {
      release();
      dashboard.incrementCompleted();
    }
  });

  dashboard.stop();
  console.log(pc.green(`\n✨ Successfully completed optimal aggregation for ${orgName}.`));
};

async function readFileList(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return await readdir(dir);
}

main().catch((error) => {
  console.error(pc.red("\n✖ Fatal aggregation error:"), error);
  process.exit(1);
});
