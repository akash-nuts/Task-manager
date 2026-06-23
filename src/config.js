import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

const ROOT = process.cwd();
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
  blueApiUrl: process.env.API_URL || "https://api.blue.app/graphql",
  blueWebBaseUrl: process.env.BLUE_WEB_BASE_URL || "https://blue.app",
  blueTaskUrlTemplate: process.env.BLUE_TASK_URL_TEMPLATE || "",
  blueClientId: process.env.CLIENT_ID || "",
  blueAuthToken: process.env.AUTH_TOKEN || "",
  blueCompanyId: process.env.COMPANY_ID || "",
  blueDefaultCompany: process.env.BLUE_DEFAULT_COMPANY || process.env.COMPANY_ID || "",
  blueMcpServerName: process.env.BLUE_MCP_SERVER_NAME || "blue-task-mcp",
  httpPort: Number(process.env.HTTP_PORT || 8787),
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET || "",
  slackBotToken: process.env.SLACK_BOT_TOKEN || "",
  slackDefaultProject: process.env.SLACK_DEFAULT_PROJECT || "",
  slackCommandName: process.env.SLACK_COMMAND_NAME || "/blue",
  slackSummaryChannelId: process.env.SLACK_SUMMARY_CHANNEL_ID || "",
  emailSharedSecret: process.env.EMAIL_SHARED_SECRET || "",
  emailDefaultProject: process.env.EMAIL_DEFAULT_PROJECT || "",
  blueWebhookSecret: process.env.BLUE_WEBHOOK_SECRET || "",
  cronSecret: process.env.CRON_SECRET || "",
  kvRestApiUrl: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "",
  kvRestApiToken: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "",
  summaryRetentionHours: Number(process.env.SUMMARY_RETENTION_HOURS || 36),
  summaryWindowHours: Number(process.env.SUMMARY_WINDOW_HOURS || 24),
  summaryInProgressLists: process.env.SUMMARY_IN_PROGRESS_LISTS || "In Progress",
  summaryDoneLists: process.env.SUMMARY_DONE_LISTS || "Done,Completed,Closed",
  summaryTodoLists: process.env.SUMMARY_TODO_LISTS || "To do,Todo,Backlog",
  summaryWorkspaceRefs: process.env.SUMMARY_WORKSPACES || ""
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
