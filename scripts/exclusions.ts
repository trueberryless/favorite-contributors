import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import pc from "picocolors";
import type { Entity } from "../src/types.ts";

const EXCLUSIONS_FILE = resolve("./data/excluded-users.json");
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

const hashUsername = (username: string): string =>
  createHash("sha256").update(username.toLowerCase()).digest("hex");

const createExclusionCheck = (hashes: Set<string>) => {
  const cache = new Map<string, boolean>();
  return (username: string): boolean => {
    let isExcluded = cache.get(username);
    if (isExcluded === undefined) {
      isExcluded = hashes.has(hashUsername(username));
      cache.set(username, isExcluded);
    }
    return isExcluded;
  };
};

const stripEntity = (entity: Entity, isExcluded: (username: string) => boolean): boolean => {
  let changed = false;
  for (const username of Object.keys(entity.stats ?? {})) {
    if (!isExcluded(username)) continue;
    delete entity.stats[username];
    changed = true;
  }
  return changed;
};

const anonymizeRawData = (rawData: RawData, isExcluded: (username: string) => boolean): boolean => {
  let changed = false;
  for (const issue of Object.values(rawData.issues ?? {})) {
    if (!issue.user || !isExcluded(issue.user.login)) continue;
    issue.user = null;
    changed = true;
  }
  for (const pr of Object.values(rawData.prs ?? {})) {
    if (pr.author && isExcluded(pr.author.login)) {
      pr.author = null;
      changed = true;
    }
    for (const review of pr.reviews?.nodes ?? []) {
      if (!review?.author || !isExcluded(review.author.login)) continue;
      review.author = null;
      changed = true;
    }
  }
  return changed;
};

const main = async (): Promise<void> => {
  const hashes = new Set(await readJson<string[]>(EXCLUSIONS_FILE));
  if (hashes.size === 0) {
    console.log(pc.green("✨ No excluded users."));
    return;
  }

  const isExcluded = createExclusionCheck(hashes);
  let updatedFiles = 0;

  const updateJson = async <T>(filePath: string, update: (data: T) => boolean): Promise<void> => {
    const data = await readJson<T>(filePath);
    if (!update(data)) return;
    await writeJson<T>(filePath, data);
    updatedFiles++;
  };

  console.log(pc.blue(`▶ Applying ${hashes.size} exclusions...`));

  for (const file of await readdir(ORGS_DIR)) {
    if (!file.endsWith(".json")) continue;
    await updateJson<Entity>(join(ORGS_DIR, file), (org) => stripEntity(org, isExcluded));
  }

  for (const orgDir of await readdir(REPOS_DIR, { withFileTypes: true })) {
    if (!orgDir.isDirectory()) continue;
    for (const file of await readdir(join(REPOS_DIR, orgDir.name))) {
      const filePath = join(REPOS_DIR, orgDir.name, file);
      if (file.endsWith(".raw.json")) {
        await updateJson<RawData>(filePath, (rawData) => anonymizeRawData(rawData, isExcluded));
      } else if (file.endsWith(".json")) {
        await updateJson<Entity>(filePath, (repo) => stripEntity(repo, isExcluded));
      }
    }
  }

  let removedProfiles = 0;
  for (const file of await readdir(CONTRIBUTORS_DIR)) {
    if (!file.endsWith(".json") || !isExcluded(file.slice(0, -".json".length))) continue;
    await unlink(join(CONTRIBUTORS_DIR, file));
    removedProfiles++;
  }

  console.log(
    pc.green(
      `✨ Updated ${updatedFiles} data files and removed ${removedProfiles} contributor profiles.`,
    ),
  );
};

interface Author {
  login: string;
}

interface RawData {
  issues: Record<number, { user: Author | null }>;
  prs: Record<
    number,
    {
      author: Author | null;
      reviews?: { nodes: Array<{ author: Author | null } | null> };
    }
  >;
}

main().catch((error) => {
  console.error(pc.red("\n✖ Fatal exclusions error:"), error);
  process.exit(1);
});
