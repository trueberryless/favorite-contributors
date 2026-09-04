import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { paginateGraphQL } from "@octokit/plugin-paginate-graphql";
import { retry } from "@octokit/plugin-retry";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import pc from "picocolors";
import type { Organisation, Repository, Stats } from "../src/types.ts";
import { TerminalDashboard } from "./utils/terminal.ts";
import {
  CONCURRENCY_LIMIT,
  MIN_STARS_THRESHOLD,
  PR_PAGE_SIZE,
  PR_BACKFILL_BATCHES_PER_RUN,
} from "./utils/consts.ts";

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

const toIssueItem = (issue: any): IssueItem => ({
  number: issue.number,
  user: issue.user ? { login: issue.user.login, type: issue.user.type } : null,
  reactions: issue.reactions?.total_count
    ? { total_count: issue.reactions.total_count }
    : undefined,
});

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

const computeScore = (stats: Omit<Stats, "score">): number => {
  return Math.round(
    stats.mergedPrs * 5 +
      stats.reviews * 3 +
      stats.reviewsReceived * 1 +
      stats.issuesLinked * 2 +
      stats.reactions * 0.1,
  );
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
  user: { login: string; type: string } | null;
  reactions?: { total_count: number };
}

interface GraphQLPullRequestNode {
  number: number;
  updatedAt: string;
  author: { login: string; __typename: string } | null;
  merged: boolean;
  closingIssuesReferences: { totalCount: number };
  reactions: { totalCount: number };
  reviews: {
    nodes: Array<{ state: string; author: { login: string; __typename: string } | null } | null>;
  };
}

interface GraphQLResponse {
  repository: {
    pullRequests: {
      nodes: Array<GraphQLPullRequestNode | null>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

interface RepoRawData {
  syncState: {
    lastRunAt: string | null;
    prBackfillCursor: string | null;
    prBackfillComplete: boolean;
    issuesBackfillComplete: boolean;
  };
  issues: Record<number, IssueItem>;
  prs: Record<number, GraphQLPullRequestNode>;
}

const main = async (): Promise<void> => {
  const orgName = process.argv[2];
  if (!orgName) {
    console.error(pc.red("✖ Error: Organization name argument is required."));
    process.exit(1);
  }

  const orgFilePath = join(ORGS_DIR, `${orgName}.json`);
  const orgReposDir = join(REPOS_DIR, orgName);
  await mkdir(orgReposDir, { recursive: true });

  const repos = (await octokit.paginate("GET /orgs/{org}/repos", {
    org: orgName,
    type: "sources",
    per_page: 100,
  })) as Repo[];
  const publicRepos = repos.filter(
    (repo) => !repo.private && repo.stargazers_count >= MIN_STARS_THRESHOLD,
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
    const rawFilePath = join(orgReposDir, `${repoName}.raw.json`);
    const currentRunTimestamp = new Date().toISOString();

    let repoEntry: Repository;
    try {
      repoEntry = await readJson<Repository>(repoFilePath);
    } catch {
      repoEntry = { id: `${orgName}/${repoName}`, updatedAt: null, stats: {} };
    }

    let rawData: RepoRawData;
    try {
      rawData = await readJson<RepoRawData>(rawFilePath);
    } catch {
      rawData = {
        syncState: {
          lastRunAt: null,
          prBackfillCursor: null,
          prBackfillComplete: false,
          issuesBackfillComplete: false,
        },
        issues: {},
        prs: {},
      };
    }

    if (!rawData.syncState) {
      rawData.syncState = {
        lastRunAt: null,
        prBackfillCursor: null,
        prBackfillComplete: false,
        issuesBackfillComplete: false,
      };
    }

    const fetchGraphQLBatchSafe = async (
      cursor: string | null,
      initialPageSize: number = PR_PAGE_SIZE,
    ) => {
      let currentSize = initialPageSize;

      while (currentSize >= 1) {
        try {
          return (await octokit.graphql(
            `
            query($org: String!, $repo: String!, $cursor: String, $pageSize: Int!) {
              repository(owner: $org, name: $repo) {
                pullRequests(first: $pageSize, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}, states: [MERGED, CLOSED, OPEN]) {
                  pageInfo { hasNextPage, endCursor }
                  nodes {
                    number, updatedAt, merged
                    author { login, __typename }
                    closingIssuesReferences(first: 10) { totalCount }
                    reactions { totalCount }
                    reviews(first: 30) { nodes { state, author { login, __typename } } }
                  }
                }
              }
            }
          `,
            { org: orgName, repo: repoName, cursor, pageSize: currentSize },
          )) as GraphQLResponse;
        } catch (error: any) {
          if (error.status && error.status >= 500) {
            if (currentSize === 1) {
              throw new Error(`Unrecoverable 500 error at cursor ${cursor} even with pageSize 1.`);
            }
            currentSize = Math.floor(currentSize / 2);
            dashboard.updateWorker(
              workerIndex,
              repoName,
              pc.yellow(`⚠ 500 Timeout. Retrying batch with size ${currentSize}...`),
              colorize,
            );
          } else {
            throw error;
          }
        }
      }
      throw new Error("Unexpected end of fetch loop");
    };

    if (rawData.syncState.lastRunAt) {
      dashboard.updateWorker(
        workerIndex,
        repoName,
        pc.blue("Phase 1: Fetching recent updates..."),
        colorize,
      );

      try {
        const fetchedIssues = (await octokit.paginate("GET /repos/{owner}/{repo}/issues", {
          owner: orgName,
          repo: repoName,
          state: "all",
          per_page: 100,
          since: rawData.syncState.lastRunAt,
        })) as IssueItem[];
        for (const issue of fetchedIssues) rawData.issues[issue.number] = toIssueItem(issue);

        let hasNext = true;
        let updateCursor: string | null = null;
        let newPrsFound = 0;

        while (hasNext) {
          const res = await fetchGraphQLBatchSafe(updateCursor, PR_PAGE_SIZE);
          const prs = res.repository.pullRequests;
          let reachedOld = false;

          for (const node of prs.nodes) {
            if (!node) continue;
            if (node.updatedAt <= rawData.syncState.lastRunAt!) {
              reachedOld = true;
              break;
            }
            rawData.prs[node.number] = node;
            newPrsFound++;
          }

          if (reachedOld) break;
          hasNext = prs.pageInfo.hasNextPage;
          updateCursor = prs.pageInfo.endCursor;
        }
        dashboard.updateWorker(
          workerIndex,
          repoName,
          pc.blue(`Phase 1 Done. Caught ${newPrsFound} PR updates.`),
          colorize,
        );
      } catch (error) {
        dashboard.updateWorker(
          workerIndex,
          repoName,
          pc.yellow(`⚠ Phase 1 partial failure. Saving what we have.`),
          colorize,
        );
      }
    }

    if (!rawData.syncState.issuesBackfillComplete) {
      dashboard.updateWorker(
        workerIndex,
        repoName,
        pc.yellow("Phase 2: Full historical issue backfill..."),
        colorize,
      );
      try {
        const allIssues = (await octokit.paginate("GET /repos/{owner}/{repo}/issues", {
          owner: orgName,
          repo: repoName,
          state: "all",
          per_page: 100,
        })) as IssueItem[];
        for (const issue of allIssues) rawData.issues[issue.number] = toIssueItem(issue);
        rawData.syncState.issuesBackfillComplete = true;
      } catch (error) {
        dashboard.updateWorker(
          workerIndex,
          repoName,
          pc.yellow(`⚠ Issues backfill paused due to limit.`),
          colorize,
        );
      }
    }

    if (!rawData.syncState.prBackfillComplete) {
      let backfillBatchCount = 0;

      while (
        !rawData.syncState.prBackfillComplete &&
        backfillBatchCount < PR_BACKFILL_BATCHES_PER_RUN
      ) {
        dashboard.updateWorker(
          workerIndex,
          repoName,
          pc.yellow(
            `Phase 2: PR Backfill batch ${backfillBatchCount + 1}/${PR_BACKFILL_BATCHES_PER_RUN}...`,
          ),
          colorize,
        );

        try {
          const res = await fetchGraphQLBatchSafe(
            rawData.syncState.prBackfillCursor,
            PR_PAGE_SIZE,
          );
          const prs = res.repository.pullRequests;

          for (const node of prs.nodes) {
            if (!node) continue;
            if (!rawData.prs[node.number] || rawData.prs[node.number].updatedAt < node.updatedAt) {
              rawData.prs[node.number] = node;
            }
          }

          rawData.syncState.prBackfillCursor = prs.pageInfo.endCursor;
          if (!prs.pageInfo.hasNextPage) {
            rawData.syncState.prBackfillComplete = true;
          }
          backfillBatchCount++;
        } catch (error) {
          dashboard.updateWorker(
            workerIndex,
            repoName,
            pc.red(`⚠ PR Backfill paused for this run. Saving progress.`),
            colorize,
          );
          break;
        }
      }
    }

    rawData.syncState.lastRunAt = currentRunTimestamp;
    await writeJson<RepoRawData>(rawFilePath, rawData);

    dashboard.updateWorker(
      workerIndex,
      repoName,
      pc.blue("Aggregating stats from cache..."),
      colorize,
    );
    const newStats: Record<string, Stats> = {};
    const initializeUser = (login: string) => {
      if (!newStats[login]) {
        newStats[login] = {
          score: 0,
          mergedPrs: 0,
          reviews: 0,
          reviewsReceived: 0,
          issuesLinked: 0,
          reactions: 0,
        };
      }
    };

    for (const issue of Object.values(rawData.issues)) {
      if (!issue.user || issue.user.type === "Bot") continue;
      initializeUser(issue.user.login);
      if (issue.reactions?.total_count)
        newStats[issue.user.login].reactions += issue.reactions.total_count;
    }

    for (const pr of Object.values(rawData.prs)) {
      const authorLogin = pr.author?.login;
      const isHumanAuthor = authorLogin && pr.author?.__typename !== "Bot";

      if (isHumanAuthor) {
        initializeUser(authorLogin);
        if (pr.reactions?.totalCount) newStats[authorLogin].reactions += pr.reactions.totalCount;
      }

      if (pr.merged) {
        if (isHumanAuthor) {
          newStats[authorLogin].mergedPrs += 1;
          if (pr.closingIssuesReferences?.totalCount)
            newStats[authorLogin].issuesLinked += pr.closingIssuesReferences.totalCount;
        }

        if (pr.reviews?.nodes) {
          const reviewersForThisPr = new Set<string>();
          let approvalCount = 0;

          for (const review of pr.reviews.nodes) {
            if (!review || !review.author || review.author.__typename === "Bot") continue;
            if (["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(review.state))
              reviewersForThisPr.add(review.author.login);
            if (review.state === "APPROVED") approvalCount += 1;
          }

          for (const reviewerLogin of reviewersForThisPr) {
            initializeUser(reviewerLogin);
            newStats[reviewerLogin].reviews += 1;
          }
          if (isHumanAuthor) newStats[authorLogin].reviewsReceived += approvalCount;
        }
      }
    }

    for (const username of Object.keys(newStats))
      newStats[username].score = computeScore(newStats[username]);

    repoEntry.stats = sortObjectKeys(newStats);
    repoEntry.updatedAt = currentRunTimestamp;
    await writeJson<Repository>(repoFilePath, repoEntry);

    dashboard.updateWorker(workerIndex, repoName, pc.yellow("Syncing to Org..."), colorize);
    const release = await orgMutex.lock();
    try {
      const repoFiles = await readFileList(orgReposDir);
      const combinedOrgStats: Record<string, Stats> = {};

      for (const file of repoFiles) {
        if (!file.endsWith(".json") || file.endsWith(".raw.json")) continue;
        try {
          const rData = await readJson<Repository>(join(orgReposDir, file));
          for (const [username, stats] of Object.entries(rData.stats)) {
            if (!combinedOrgStats[username])
              combinedOrgStats[username] = {
                score: 0,
                mergedPrs: 0,
                reviews: 0,
                reviewsReceived: 0,
                issuesLinked: 0,
                reactions: 0,
              };
            combinedOrgStats[username].mergedPrs += stats.mergedPrs;
            combinedOrgStats[username].reviews += stats.reviews;
            combinedOrgStats[username].reviewsReceived += stats.reviewsReceived;
            combinedOrgStats[username].issuesLinked += stats.issuesLinked;
            combinedOrgStats[username].reactions += stats.reactions;
          }
        } catch {}
      }

      for (const username of Object.keys(combinedOrgStats))
        combinedOrgStats[username].score = computeScore(combinedOrgStats[username]);

      const orgData = await readJson<Organisation>(orgFilePath);
      orgData.stats = sortObjectKeys(combinedOrgStats);
      await writeJson<Organisation>(orgFilePath, orgData);

      let badge = rawData.syncState.prBackfillComplete
        ? "✔ Done (Fully Synced)"
        : "✔ Done (Backfilling...)";
      dashboard.updateWorker(workerIndex, repoName, pc.green(badge), colorize);
    } finally {
      release();
      dashboard.incrementCompleted();
    }
  });

  dashboard.stop();
  const finalOrgData = await readJson<Organisation>(orgFilePath);
  finalOrgData.updatedAt = new Date().toISOString();
  await writeJson<Organisation>(orgFilePath, finalOrgData);
  console.log(pc.green(`\n✨ Finished aggregation for ${orgName}.`));
};

async function readFileList(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return await readdir(dir);
}

main().catch((error) => {
  console.error(pc.red("\n✖ Fatal aggregation error:"), error);
  process.exit(1);
});
