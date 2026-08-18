import { readdir, readFile, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Organisation } from "../../src/types.ts";
import { MAX_MATRIX_SIZE } from "../utils/consts.ts";

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
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return aTime - bTime;
    })
    .slice(0, MAX_MATRIX_SIZE)
    .map((entry) => entry.id);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    await appendFile(githubOutput, `orgs=${JSON.stringify(filteredOrgs)}\n`);
  }
};

main().catch(() => process.exit(1));
