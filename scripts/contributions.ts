import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import pc from "picocolors";
import type { Stats, Contributor, Organisation, Repository } from "../src/types.ts";
import { TerminalDashboard } from "./utils/terminal.ts";

const ORGS_DIR = resolve("./data/organisations");
const REPOS_DIR = resolve("./data/repositories");
const CONTRIBUTORS_DIR = resolve("./data/contributors");

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

const computeScore = (stats: Omit<Stats, "score">): number => {
  return Math.round(
    stats.mergedPrs * 5 +
      stats.reviews * 3 +
      stats.reviewsReceived * 1 +
      stats.issuesLinked * 2 +
      stats.reactions * 0.1,
  );
};

const main = async (): Promise<void> => {
  try {
    await mkdir(CONTRIBUTORS_DIR, { recursive: true });
  } catch (error) {
    console.error(
      pc.red(`✖ Error: Failed to create contributors directory at ${CONTRIBUTORS_DIR}`),
      error,
    );
    process.exit(1);
  }

  let files: string[];
  try {
    files = await readdir(ORGS_DIR);
  } catch (error) {
    console.error(pc.red(`✖ Error: Failed to read organisations directory at ${ORGS_DIR}`), error);
    return;
  }

  const orgFiles = files.filter((f) => f.endsWith(".json"));
  const users = new Map<string, Contributor>();

  console.log(pc.blue(`▶ Processing ${orgFiles.length} organisations for contributions...`));
  const dashboard = new TerminalDashboard(1, orgFiles.length);

  for (const file of orgFiles) {
    const orgFilePath = join(ORGS_DIR, file);
    let orgEntry: Organisation;
    try {
      orgEntry = await readJson<Organisation>(orgFilePath);
    } catch {
      dashboard.incrementCompleted();
      continue;
    }

    if (!orgEntry.stats) {
      dashboard.incrementCompleted();
      continue;
    }

    const orgName = orgEntry.id;
    dashboard.updateWorker(0, orgName, pc.blue("Aggregating stats..."), pc.cyan);

    for (const [username, rawStats] of Object.entries(orgEntry.stats)) {
      if (!users.has(username)) {
        users.set(username, {
          username,
          lastUpdated: new Date().toISOString(),
          aggregatedStats: {
            score: 0,
            mergedPrs: 0,
            reviews: 0,
            reviewsReceived: 0,
            issuesLinked: 0,
            reactions: 0,
          },
          orgStats: {},
          repoStats: {},
        });
      }

      const user = users.get(username)!;

      user.orgStats[orgName] = {
        score: computeScore(rawStats),
        mergedPrs: rawStats.mergedPrs,
        reviews: rawStats.reviews,
        reviewsReceived: rawStats.reviewsReceived,
        issuesLinked: rawStats.issuesLinked,
        reactions: rawStats.reactions,
      };

      if (!user.repoStats[orgName]) {
        user.repoStats[orgName] = {};
      }
    }

    let repoFiles: string[] = [];
    try {
      repoFiles = await readdir(join(REPOS_DIR, orgName));
    } catch {
      dashboard.updateWorker(0, orgName, pc.green("✔ Done."), pc.cyan);
      dashboard.incrementCompleted();
      continue;
    }

    const repoJsons = repoFiles.filter((f) => f.endsWith(".json"));

    for (const repoFile of repoJsons) {
      const repoFilePath = join(REPOS_DIR, orgName, repoFile);
      let repoEntry: Repository;
      try {
        repoEntry = await readJson<Repository>(repoFilePath);
      } catch {
        continue;
      }

      if (!repoEntry.stats) {
        continue;
      }

      const repoName = repoFile.replace(".json", "");

      for (const [username, rawStats] of Object.entries(repoEntry.stats)) {
        if (!users.has(username)) {
          users.set(username, {
            username,
            lastUpdated: new Date().toISOString(),
            aggregatedStats: {
              score: 0,
              mergedPrs: 0,
              reviews: 0,
              reviewsReceived: 0,
              issuesLinked: 0,
              reactions: 0,
            },
            orgStats: {},
            repoStats: {},
          });
        }

        const user = users.get(username)!;

        if (!user.repoStats[orgName]) {
          user.repoStats[orgName] = {};
        }

        user.repoStats[orgName][repoName] = {
          score: computeScore(rawStats),
          mergedPrs: rawStats.mergedPrs,
          reviews: rawStats.reviews,
          reviewsReceived: rawStats.reviewsReceived,
          issuesLinked: rawStats.issuesLinked,
          reactions: rawStats.reactions,
        };
      }
    }

    dashboard.updateWorker(0, orgName, pc.green("✔ Done."), pc.cyan);
    dashboard.incrementCompleted();
  }

  dashboard.stop();
  console.log(pc.blue(`▶ Saving ${users.size} contributor profiles...`));

  for (const user of users.values()) {
    const agg: Omit<Stats, "score"> = {
      mergedPrs: 0,
      reviews: 0,
      reviewsReceived: 0,
      issuesLinked: 0,
      reactions: 0,
    };

    for (const orgScore of Object.values(user.orgStats)) {
      agg.mergedPrs += orgScore.mergedPrs;
      agg.reviews += orgScore.reviews;
      agg.reviewsReceived += orgScore.reviewsReceived;
      agg.issuesLinked += orgScore.issuesLinked;
      agg.reactions += orgScore.reactions;
    }

    const newAggregatedStats = {
      score: computeScore(agg),
      mergedPrs: agg.mergedPrs,
      reviews: agg.reviews,
      reviewsReceived: agg.reviewsReceived,
      issuesLinked: agg.issuesLinked,
      reactions: agg.reactions,
    };

    user.orgStats = sortObjectKeys(user.orgStats);
    for (const orgName of Object.keys(user.repoStats)) {
      user.repoStats[orgName] = sortObjectKeys(user.repoStats[orgName]);
    }
    user.repoStats = sortObjectKeys(user.repoStats);

    const contributorFilePath = join(CONTRIBUTORS_DIR, `${user.username}.json`);
    let existingUser: Contributor | null = null;
    try {
      existingUser = await readJson<Contributor>(contributorFilePath);
    } catch {
      existingUser = null;
    }

    const clonedExisting = existingUser ? { ...existingUser } : null;
    if (clonedExisting) {
      delete (clonedExisting as any).lastUpdated;
    }

    const clonedNew = {
      username: user.username,
      aggregatedStats: newAggregatedStats,
      orgStats: user.orgStats,
      repoStats: user.repoStats,
    };

    if (clonedExisting && JSON.stringify(clonedExisting) === JSON.stringify(clonedNew)) {
      user.lastUpdated = existingUser!.lastUpdated;
    } else {
      user.lastUpdated = new Date().toISOString();
    }
    user.aggregatedStats = newAggregatedStats;

    try {
      await writeJson<Contributor>(contributorFilePath, user);
    } catch (error) {
      console.error(
        pc.yellow(`⚠ Error: Failed to write contributor file for ${user.username}`),
        error,
      );
    }
  }

  console.log(pc.green(`\n✨ Successfully updated all contributors.`));
};

main().catch((error) => {
  console.error(pc.red("\n✖ Fatal contributor updates error:"), error);
  process.exit(1);
});
