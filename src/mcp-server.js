import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { config } from "./config.js";
import {
  handleCommentTask,
  handleCreateTask,
  handleListTasks,
  handleListWorkspaceLists,
  handleListWorkspaces,
  handleMoveTask,
  handleSearchTasks,
  handleUpdateTask
} from "./task-router.js";

const server = new McpServer({
  name: config.blueMcpServerName,
  version: "0.1.0"
});

function asTextContent(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

server.registerTool(
  "list_projects",
  {
    description: "List configured Blue project aliases that this integration can manage.",
    inputSchema: z.object({})
  },
  async () =>
    asTextContent({
      defaultProject: config.projectConfig.defaultProject,
      projects: config.projectConfig.projects
    })
);

server.registerTool(
  "list_workspaces",
  {
    description: "List Blue workspaces available in the authenticated company.",
    inputSchema: z.object({})
  },
  async () => asTextContent(await handleListWorkspaces())
);

server.registerTool(
  "list_workspace_lists",
  {
    description: "List Blue lists in a workspace by workspace name or ID.",
    inputSchema: z.object({
      project: z.string().optional(),
      workspace: z.string().optional()
    })
  },
  async (input) => asTextContent(await handleListWorkspaceLists(input))
);

server.registerTool(
  "create_task",
  {
    description: "Create a Blue task in a configured project or any Blue workspace by name.",
    inputSchema: z.object({
      project: z.string().optional(),
      workspace: z.string().optional(),
      title: z.string(),
      description: z.string().optional(),
      assignees: z.array(z.string()).optional(),
      tagIds: z.array(z.string()).optional(),
      customFields: z.string().optional(),
      list: z.string().optional(),
      listId: z.string().optional()
    })
  },
  async (input) => asTextContent(await handleCreateTask(input))
);

server.registerTool(
  "update_task",
  {
    description: "Update a Blue task by record ID.",
    inputSchema: z.object({
      project: z.string().optional(),
      workspace: z.string().optional(),
      recordId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      assignees: z.array(z.string()).optional(),
      tagIds: z.array(z.string()).optional(),
      customFields: z.string().optional()
    })
  },
  async (input) => asTextContent(await handleUpdateTask(input))
);

server.registerTool(
  "move_task",
  {
    description: "Move a Blue task to a different list by list name or list ID.",
    inputSchema: z.object({
      project: z.string().optional(),
      workspace: z.string().optional(),
      recordId: z.string(),
      list: z.string().optional(),
      listId: z.string().optional()
    })
  },
  async (input) => asTextContent(await handleMoveTask(input))
);

server.registerTool(
  "comment_task",
  {
    description: "Add a comment to a Blue task by record ID.",
    inputSchema: z.object({
      project: z.string().optional(),
      workspace: z.string().optional(),
      recordId: z.string(),
      text: z.string()
    })
  },
  async (input) => asTextContent(await handleCommentTask(input))
);

server.registerTool(
  "search_tasks",
  {
    description: "Search Blue tasks in a configured project or a Blue workspace by name.",
    inputSchema: z.object({
      project: z.string().optional(),
      workspace: z.string().optional(),
      query: z.string(),
      done: z.boolean().optional(),
      limit: z.number().int().positive().max(100).optional()
    })
  },
  async (input) => asTextContent(await handleSearchTasks(input))
);

server.registerTool(
  "list_tasks",
  {
    description: "List Blue tasks in a configured project or a Blue workspace by name.",
    inputSchema: z.object({
      project: z.string().optional(),
      workspace: z.string().optional(),
      done: z.boolean().optional(),
      assignee: z.string().optional()
    })
  },
  async (input) => asTextContent(await handleListTasks(input))
);

const transport = new StdioServerTransport();
await server.connect(transport);
