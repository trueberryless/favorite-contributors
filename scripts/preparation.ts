import { readdir, readFile, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Organisation } from "../src/types.ts";
import { MAX_MATRIX_SIZE } from "./utils/consts.ts";

const ORGS_DIR = resolve("./data/organisations");

const main = async (): Promise<void> => {
  const files = await readdir(ORGS_DIR);
  const organisations: Organisation[] = [];

  for (const file of files) {
    if (file.endsWith(".json")) {
      try {
        const data = await readFile(join(ORGS_DIR, file), "utf-8");
        organisations.push(JSON.parse(data));
      } catch {}
    }
  }

  const filteredOrgs = organisations
    .sort((a, b) => {
      if (!a.updatedAt && !b.updatedAt) return 0;
      if (!a.updatedAt) return -1;
      if (!b.updatedAt) return 1;
      return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    })
    .slice(0, MAX_MATRIX_SIZE)
    .map((entry) => entry.id);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    await appendFile(githubOutput, `orgs=${JSON.stringify(filteredOrgs)}\n`);
  }
};

main().catch(() => process.exit(1));
