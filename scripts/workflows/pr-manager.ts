import { execSync } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import pc from "picocolors";
import { TerminalDashboard } from "../utils/terminal.ts";

const branch = process.env.GITHUB_REF_NAME;
const isDataUpdate = branch === "chore/update-data";

if (!isDataUpdate) {
  process.exit(0);
}

const dashboard = new TerminalDashboard(1, 1);
dashboard.updateWorker(0, "PR Manager", pc.gray("Initializing..."), pc.cyan);

try {
  dashboard.updateWorker(0, "PR Manager", pc.blue("Analyzing git diff..."), pc.cyan);

  const diffOutput = execSync("git diff --name-status origin/main...HEAD", { encoding: "utf8" });
  const diffFiles = diffOutput.trim().split("\n").filter(Boolean);

  let body = "";
  let title = "";

  if (isDataUpdate) {
    title = "chore(data): update aggregated statistics";
    const orgs = new Map<string, Set<string>>();

    for (const line of diffFiles) {
      const [_, ...fileParts] = line.split("\t");
      const file = fileParts.join("\t");

      if (file.startsWith("data/repositories/")) {
        const parts = file.split("/");
        const org = parts[2];
        const repo = parts[3]?.replace(".json", "");
        if (org && repo) {
          if (!orgs.has(org)) orgs.set(org, new Set());
          orgs.get(org)!.add(repo);
        }
      } else if (file.startsWith("data/organisations/")) {
        const org = file.split("/")[2]?.replace(".json", "");
        if (org) {
          if (!orgs.has(org)) orgs.set(org, new Set());
        }
      }
    }

    body = `## 📊 Data Pipeline Updates\n\nThis PR contains the latest aggregated statistics.\n\n`;

    if (orgs.size > 0) {
      body += `### 🏢 Updated Organizations\n\n`;
      for (const [org, repos] of orgs.entries()) {
        body += `<details>\n<summary><b>${org}</b> (${repos.size} repositories updated)</summary>\n\n`;
        if (repos.size > 0) {
          body += `- ${Array.from(repos).join("\n- ")}\n`;
        } else {
          body += `_Organization stats updated._\n`;
        }
        body += `\n</details>\n\n`;
      }
    } else {
      body += `_No organization or repository changes detected._\n`;
    }
  }

  dashboard.updateWorker(0, "PR Manager", pc.yellow("Checking for existing PRs..."), pc.cyan);
  const existingPr = execSync(`gh pr list --head ${branch} --json number --jq '.[0].number'`, {
    encoding: "utf8",
  }).trim();

  writeFileSync("pr_body.md", body);
  let prUrl = "";

  if (existingPr) {
    dashboard.updateWorker(0, "PR Manager", pc.magenta(`Updating PR #${existingPr}...`), pc.cyan);
    execSync(`gh pr edit ${existingPr} --title "${title}" --body-file pr_body.md`, {
      encoding: "utf8",
    });
    prUrl = execSync(`gh pr view ${existingPr} --json url --jq .url`, { encoding: "utf8" }).trim();
  } else {
    dashboard.updateWorker(0, "PR Manager", pc.magenta(`Creating new PR...`), pc.cyan);
    prUrl = execSync(
      `gh pr create --base main --head ${branch} --title "${title}" --body-file pr_body.md`,
      { encoding: "utf8" },
    ).trim();
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    dashboard.updateWorker(0, "PR Manager", pc.blue("Writing Action summary..."), pc.cyan);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## 🚀 PR Successfully Managed\n\n**Branch:** \`${branch}\`\n**Pull Request:** [View Pull Request](${prUrl})\n`,
    );
  }

  dashboard.updateWorker(0, "PR Manager", pc.green("✔ Done."), pc.cyan);
  dashboard.incrementCompleted();
} catch (error) {
  dashboard.updateWorker(0, "PR Manager", pc.red("✖ Failed"), pc.cyan);
  dashboard.logMessage(
    pc.red(
      `\nError executing PR manager: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  process.exit(1);
} finally {
  dashboard.stop();
}
