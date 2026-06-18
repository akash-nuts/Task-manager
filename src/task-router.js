import { z } from "zod";
import {
  createComment,
  createRecord,
  listLists,
  listRecords,
  listWorkspaces,
  moveRecord,
  resolveList,
  resolveWorkspace,
  searchRecords,
  updateRecord
} from "./blue-api.js";
import { config, getProjectIfConfigured } from "./config.js";

const createTaskSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  assignees: z.array(z.string()).optional(),
  tagIds: z.array(z.string()).optional(),
  customFields: z.string().optional(),
  list: z.string().optional(),
  listId: z.string().optional()
});

const updateTaskSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  recordId: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  assignees: z.array(z.string()).optional(),
  tagIds: z.array(z.string()).optional(),
  customFields: z.string().optional()
});

const moveTaskSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  recordId: z.string().min(1),
  list: z.string().optional(),
  listId: z.string().optional()
});

const commentTaskSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  recordId: z.string().min(1),
  text: z.string().min(1)
});

const searchTaskSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  query: z.string().min(1),
  done: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional()
});

async function resolveTargetContext(input = {}) {
  const configuredProject =
    getProjectIfConfigured(input.project) ||
    (!input.workspace && config.projectConfig.defaultProject
      ? getProjectIfConfigured(config.projectConfig.defaultProject)
      : null);

  if (configuredProject) {
    const list =
      input.listId || input.list
        ? await resolveList(
            configuredProject.workspaceId,
            input.listId || input.list,
            configuredProject
          )
        : configuredProject.listId
          ? { id: configuredProject.listId, name: "default" }
          : await resolveList(configuredProject.workspaceId, null, configuredProject);

    return {
      project: configuredProject,
      workspace: {
        id: configuredProject.workspaceId,
        name: configuredProject.name
      },
      list
    };
  }

  const workspaceRef = input.workspace || input.project;
  if (!workspaceRef) {
    const result = await listWorkspaces();
    const workspaces = Array.isArray(result.data) ? result.data : [];
    const examples = workspaces.slice(0, 5).map((workspace) => workspace.name).join(", ");
    throw new Error(
      `Please specify a workspace. Example: 'create in DataCX - Active: Fix login timeout'. Available workspaces include: ${examples}`
    );
  }

  const workspace = await resolveWorkspace(workspaceRef);
  const project = {
    name: workspace.name,
    company: config.blueDefaultCompany,
    workspaceId: workspace.id,
    listId: null,
    defaultAssignees: [],
    defaultTags: []
  };
  const list = await resolveList(workspace.id, input.listId || input.list || null, project);

  return { project, workspace, list };
}

export async function handleCreateTask(input) {
  const parsed = createTaskSchema.parse(input);
  const target = await resolveTargetContext(parsed);
  const result = await createRecord(target.project, {
    ...parsed,
    listId: parsed.listId || target.list.id,
    assignees: parsed.assignees?.length ? parsed.assignees : target.project.defaultAssignees,
    tagIds: parsed.tagIds?.length ? parsed.tagIds : target.project.defaultTags
  });

  return {
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    list: target.list.name,
    result: result.data || result.stdout
  };
}

export async function handleUpdateTask(input) {
  const parsed = updateTaskSchema.parse(input);
  const target = await resolveTargetContext(parsed);
  const result = await updateRecord(target.project, parsed);

  return {
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    result: result.data || result.stdout
  };
}

export async function handleMoveTask(input) {
  const parsed = moveTaskSchema.parse(input);
  const target = await resolveTargetContext(parsed);
  const listId = parsed.listId || target.list.id;
  const result = await moveRecord(target.project, {
    ...parsed,
    listId
  });

  return {
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    list: target.list.name,
    result: result.data || result.stdout
  };
}

export async function handleCommentTask(input) {
  const parsed = commentTaskSchema.parse(input);
  const target = await resolveTargetContext(parsed);
  const result = await createComment(target.project, parsed);

  return {
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    result: result.data || result.stdout
  };
}

export async function handleSearchTasks(input) {
  const parsed = searchTaskSchema.parse(input);
  const target = await resolveTargetContext(parsed);
  const result = await searchRecords(target.project, parsed.query, {
    done: parsed.done,
    limit: parsed.limit
  });

  return {
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    result: result.data || result.stdout
  };
}

export async function handleListTasks(input = {}) {
  const target = await resolveTargetContext(input);
  const result = await listRecords(target.project, {
    done: input.done,
    assignee: input.assignee
  });

  return {
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    result: result.data || result.stdout
  };
}

export async function handleListWorkspaces() {
  const result = await listWorkspaces();
  return {
    company: config.blueDefaultCompany,
    result: result.data || result.stdout
  };
}

export async function handleListWorkspaceLists(input) {
  const configuredProject =
    getProjectIfConfigured(input.project) ||
    (!input.workspace && config.projectConfig.defaultProject
      ? getProjectIfConfigured(config.projectConfig.defaultProject)
      : null);

  let project;
  let workspace;

  if (configuredProject) {
    project = configuredProject;
    workspace = { id: configuredProject.workspaceId, name: configuredProject.name };
  } else {
    workspace = await resolveWorkspace(input.workspace || input.project);
    project = {
      name: workspace.name,
      company: config.blueDefaultCompany,
      workspaceId: workspace.id,
      listId: null,
      defaultAssignees: [],
      defaultTags: []
    };
  }

  const result = await listLists(project.workspaceId, project);
  return {
    workspace: workspace.name,
    workspaceId: project.workspaceId,
    result: result.data || result.stdout
  };
}

export function parseHumanCommand(text, fallbackWorkspace) {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    throw new Error("Command text is empty.");
  }

  const createMatch = trimmed.match(/^create(?:\s+in\s+(.+?))?\s*:\s*(.+)$/i);
  if (createMatch) {
    if (!createMatch[1] && !fallbackWorkspace) {
      throw new Error(
        "Please choose a workspace in the command. Example: 'create in DataCX - Active: Fix login timeout'."
      );
    }

    return {
      action: "create",
      payload: {
        workspace: createMatch[1]?.trim() || fallbackWorkspace,
        title: createMatch[2].trim()
      }
    };
  }

  const commentMatch = trimmed.match(/^comment\s+(\S+)\s*:\s*(.+)$/i);
  if (commentMatch) {
    if (!fallbackWorkspace) {
      throw new Error(
        "Please include a workspace before commenting, for example: 'comment in DataCX - Active 12345: Please prioritize this'."
      );
    }

    return {
      action: "comment",
      payload: {
        workspace: fallbackWorkspace,
        recordId: commentMatch[1],
        text: commentMatch[2].trim()
      }
    };
  }

  const moveMatch = trimmed.match(/^move\s+(\S+)\s+to\s+(.+)$/i);
  if (moveMatch) {
    if (!fallbackWorkspace) {
      throw new Error(
        "Please include the workspace in the request before moving a task."
      );
    }

    return {
      action: "move",
      payload: {
        workspace: fallbackWorkspace,
        recordId: moveMatch[1],
        list: moveMatch[2].trim()
      }
    };
  }

  const searchMatch = trimmed.match(/^search(?:\s+in\s+(.+?))?\s*:\s*(.+)$/i);
  if (searchMatch) {
    if (!searchMatch[1] && !fallbackWorkspace) {
      throw new Error(
        "Please choose a workspace in the command. Example: 'search in DataCX - Active: onboarding'."
      );
    }

    return {
      action: "search",
      payload: {
        workspace: searchMatch[1]?.trim() || fallbackWorkspace,
        query: searchMatch[2].trim()
      }
    };
  }

  throw new Error(
    "Unsupported command format. Try 'create in MA-EU: Fix login bug' or 'search in 4ay-AI-CRM: onboarding'."
  );
}

export async function dispatchHumanCommand(text, fallbackWorkspace) {
  const command = parseHumanCommand(text, fallbackWorkspace);

  switch (command.action) {
    case "create":
      return handleCreateTask(command.payload);
    case "comment":
      return handleCommentTask(command.payload);
    case "move":
      return handleMoveTask(command.payload);
    case "search":
      return handleSearchTasks(command.payload);
    default:
      throw new Error(`Unsupported action '${command.action}'.`);
  }
}
