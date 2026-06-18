import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

const ROOT = process.cwd();
const BUNDLED_BLUE_CLI_PATH = path.join(ROOT, "tools", "blue-cli", "blue.exe");
const PROJECT_CONFIG_FILES = [
  "blue-projects.local.json",
  "blue-projects.json",
  "blue-projects.example.json"
];

function loadProjectConfig() {
  for (const file of PROJECT_CONFIG_FILES) {
    const fullPath = path.join(ROOT, file);
    if (fs.existsSync(fullPath)) {
      return {
        path: fullPath,
        data: JSON.parse(fs.readFileSync(fullPath, "utf8"))
      };
    }
  }

  return {
    path: null,
    data: {
      defaultProject: null,
      projects: {}
    }
  };
}

const projectConfig = loadProjectConfig();

export const config = {
  rootDir: ROOT,
  projectConfigPath: projectConfig.path,
  projectConfig: projectConfig.data,
  blueCliPath:
    process.env.BLUE_CLI_PATH ||
    (fs.existsSync(BUNDLED_BLUE_CLI_PATH) ? BUNDLED_BLUE_CLI_PATH : "blue"),
  blueDefaultCompany: process.env.BLUE_DEFAULT_COMPANY || process.env.COMPANY_ID || "",
  blueMcpServerName: process.env.BLUE_MCP_SERVER_NAME || "blue-task-mcp",
  httpPort: Number(process.env.HTTP_PORT || 8787),
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET || "",
  slackBotToken: process.env.SLACK_BOT_TOKEN || "",
  slackDefaultProject: process.env.SLACK_DEFAULT_PROJECT || "",
  slackCommandName: process.env.SLACK_COMMAND_NAME || "/blue",
  emailSharedSecret: process.env.EMAIL_SHARED_SECRET || "",
  emailDefaultProject: process.env.EMAIL_DEFAULT_PROJECT || ""
};

export function getProject(projectName) {
  const requestedName =
    projectName ||
    config.projectConfig.defaultProject ||
    config.slackDefaultProject ||
    config.emailDefaultProject;

  if (!requestedName) {
    throw new Error(
      "No project specified and no default project configured. Set one in blue-projects.local.json."
    );
  }

  const project = config.projectConfig.projects[requestedName];
  if (!project) {
    throw new Error(`Unknown project '${requestedName}'.`);
  }

  return {
    name: requestedName,
    company: project.company || config.blueDefaultCompany,
    workspaceId: project.workspaceId,
    listId: project.listId,
    defaultAssignees: project.defaultAssignees || [],
    defaultTags: project.defaultTags || []
  };
}

export function getProjectIfConfigured(projectName) {
  if (!projectName) {
    return null;
  }

  const project = config.projectConfig.projects[projectName];
  if (!project) {
    return null;
  }

  return {
    name: projectName,
    company: project.company || config.blueDefaultCompany,
    workspaceId: project.workspaceId,
    listId: project.listId,
    defaultAssignees: project.defaultAssignees || [],
    defaultTags: project.defaultTags || []
  };
}
