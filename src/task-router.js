import { z } from "zod";
import {
  createComment,
  createRecord,
  getRecord,
  listLists,
  listRecords,
  listWorkspaces,
  moveRecord,
  resolveAssignees,
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
  description: z.string().min(1),
  assignees: z.array(z.string().min(1)).min(1),
  tagIds: z.array(z.string()).optional(),
  customFields: z.string().optional(),
  list: z.string().optional(),
  listId: z.string().optional()
});

const bulkCreateTaskSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  titles: z.array(z.string().min(1)).min(1).max(100),
  description: z.string().min(1),
  assignees: z.array(z.string().min(1)).min(1),
  tagIds: z.array(z.string()).optional(),
  customFields: z.string().optional(),
  list: z.string().optional(),
  listId: z.string().optional()
});

const updateTaskSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  recordId: z.string().min(1).optional(),
  taskQuery: z.string().min(1).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  assignees: z.array(z.string()).optional(),
  tagIds: z.array(z.string()).optional(),
  customFields: z.string().optional()
});

const moveTaskSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  recordId: z.string().min(1).optional(),
  taskQuery: z.string().min(1).optional(),
  list: z.string().optional(),
  listId: z.string().optional()
});

const commentTaskSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  recordId: z.string().min(1).optional(),
  taskQuery: z.string().min(1).optional(),
  text: z.string().min(1)
});

const searchTaskSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  query: z.string().min(1),
  done: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional()
});

const statusTaskSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  recordId: z.string().min(1).optional(),
  taskQuery: z.string().min(1).optional()
});

const listTaskSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  list: z.string().optional(),
  done: z.boolean().optional(),
  assignee: z.string().optional(),
  limit: z.number().int().positive().max(100).optional()
});

export function getSlackHelpText() {
  return [
    "Here are the commands I support:",
    "",
    "1. Create a task",
    "/blue create a task in DataCX - Active | Checkout button overlaps footer on mobile Safari | Akash H",
    "",
    "2. Create a task with explicit title, description, and assignee",
    "/blue create in DataCX - Active: Checkout footer bug | desc: Checkout button overlaps footer on mobile Safari | assignee: Akash H",
    "",
    "3. Bulk create tasks",
    "/blue bulk create in DataCX - Active: desc: Sprint intake | assignee: Akash H | Fix login ; Add QA checklist ; Review handoff",
    "",
    "4. Search tasks",
    "/blue search in DataCX - Active: checkout",
    "",
    "5. List tasks",
    "/blue list tasks in DataCX - Active",
    "/blue list tasks in DataCX - Active: In Progress",
    "",
    "6. Check task status",
    "/blue status in DataCX - Active: checkout footer",
    "",
    "7. Update a task",
    "/blue update in DataCX - Active: checkout footer | desc: Repro on iPhone 14 Safari | assignee: Akash H",
    "",
    "8. Move a task",
    "/blue move in DataCX - Active: checkout footer | QA",
    "",
    "9. Comment on a task",
    "/blue comment in DataCX - Active: checkout footer | Please verify on iPhone 14",
    "",
    "Tips:",
    "- For the short create format, the structure is: workspace | full description | assignee",
    "- I will generate a shorter title automatically from the description",
    "- If a workspace or task name is unclear, I will suggest matches in Slack",
    "- Help and errors stay private, while successful create or update actions can post to the channel"
  ].join("\n");
}

function normalizeLookupValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function resolveExistingTaskContext(input = {}) {
  if (!input.recordId) {
    throw new Error("Task ID is required.");
  }

  const recordResult = await getRecord(input.recordId);
  const record = recordResult.data;

  if (!record?.list?.workspaceId) {
    throw new Error(`Task '${input.recordId}' is missing workspace details in Blue.`);
  }

  const list = record.list?.id
    ? {
        id: record.list.id,
        name: record.list.name
      }
    : null;

  return {
    project: {
      name: record.list.workspace || input.workspace || "Blue",
      company: config.blueDefaultCompany,
      workspaceId: record.list.workspaceId,
      listId: list?.id || null,
      defaultAssignees: [],
      defaultTags: []
    },
    workspace: {
      id: record.list.workspaceId,
      name: record.list.workspace || input.workspace || "Blue"
    },
    list,
    record
  };
}

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

  if (!input.workspace && input.recordId) {
    const existing = await resolveExistingTaskContext(input);
    if (input.listId || input.list) {
      existing.list = await resolveList(existing.project.workspaceId, input.listId || input.list, existing.project);
    }
    return existing;
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
  const list =
    input.listId || input.list || input.recordId
      ? await resolveList(workspace.id, input.listId || input.list || null, project)
      : null;

  return { project, workspace, list };
}

async function resolveCreateDefaults(target, parsed) {
  const assigneeUsers = await resolveAssignees(target.project.workspaceId, parsed.assignees);

  return {
    assigneeIds: assigneeUsers.map((user) => user.id),
    assigneeUsers
  };
}

export async function handleCreateTask(input) {
  const parsed = createTaskSchema.parse(input);
  const target = await resolveTargetContext(parsed);
  const list = target.list || (await resolveList(target.project.workspaceId, null, target.project));
  const resolved = await resolveCreateDefaults(target, parsed);
  const result = await createRecord(target.project, {
    ...parsed,
    listId: parsed.listId || list.id,
    assignees: resolved.assigneeIds,
    tagIds: parsed.tagIds?.length ? parsed.tagIds : target.project.defaultTags
  });

  return {
    action: "create",
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    list: list.name,
    result: result.data || result.stdout
  };
}

export async function handleBulkCreateTask(input) {
  const parsed = bulkCreateTaskSchema.parse(input);
  const target = await resolveTargetContext(parsed);
  const list = target.list || (await resolveList(target.project.workspaceId, null, target.project));
  const resolved = await resolveCreateDefaults(target, parsed);
  const titles = parsed.titles.map((title) => title.trim()).filter(Boolean);
  const created = [];

  for (const title of titles) {
    const result = await createRecord(target.project, {
      ...parsed,
      title,
      listId: parsed.listId || list.id,
      assignees: resolved.assigneeIds,
      tagIds: parsed.tagIds?.length ? parsed.tagIds : target.project.defaultTags
    });

    created.push(result.data || result.stdout);
  }

  return {
    action: "bulk_create",
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    list: list.name,
    result: {
      createdCount: created.length,
      created
    }
  };
}

export async function handleUpdateTask(input) {
  const parsed = updateTaskSchema.parse(input);
  if (!parsed.recordId) {
    throw new Error("Please select a task first before updating it.");
  }

  const target = await resolveTargetContext(parsed);
  const assigneeIds = parsed.assignees?.length
    ? (await resolveAssignees(target.project.workspaceId, parsed.assignees)).map((user) => user.id)
    : undefined;
  const result = await updateRecord(target.project, {
    ...parsed,
    assignees: assigneeIds
  });

  return {
    action: "update",
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    result: result.data || result.stdout
  };
}

export async function handleMoveTask(input) {
  const parsed = moveTaskSchema.parse(input);
  if (!parsed.recordId) {
    throw new Error("Please select a task first before moving it.");
  }

  const target = await resolveTargetContext(parsed);
  const list = target.list || (await resolveList(target.project.workspaceId, parsed.listId || parsed.list, target.project));
  const result = await moveRecord(target.project, {
    ...parsed,
    listId: parsed.listId || list.id
  });

  return {
    action: "move",
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    list: list.name,
    result: result.data || result.stdout
  };
}

export async function handleCommentTask(input) {
  const parsed = commentTaskSchema.parse(input);
  if (!parsed.recordId) {
    throw new Error("Please select a task first before commenting on it.");
  }

  const target = await resolveTargetContext(parsed);
  const result = await createComment(target.project, parsed);

  return {
    action: "comment",
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    recordId: parsed.recordId,
    comment: result.data || result.stdout,
    result: target.record || (await getRecord(parsed.recordId)).data
  };
}

export async function handleSearchTasks(input) {
  const parsed = searchTaskSchema.parse(input);
  const target = await resolveTargetContext(parsed);
  const result = await searchRecords(target.project, parsed.query, {
    done: parsed.done,
    limit: parsed.limit || 5
  });

  return {
    action: "search",
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    query: parsed.query,
    result: result.data || result.stdout
  };
}

export async function handleStatusTask(input) {
  const parsed = statusTaskSchema.parse(input);
  if (!parsed.recordId) {
    throw new Error("Please select a task first before checking its status.");
  }

  const record = (await getRecord(parsed.recordId)).data;

  return {
    action: "status",
    project: record.list?.workspace || parsed.workspace || "Blue",
    workspace: record.list?.workspace || parsed.workspace || "Blue",
    workspaceId: record.list?.workspaceId || "",
    result: record
  };
}

export async function handleListTasks(input = {}) {
  const parsed = listTaskSchema.parse(input);
  const target = await resolveTargetContext(parsed);
  const result = await listRecords(target.project, {
    done: parsed.done,
    assignee: parsed.assignee
  });

  let tasks = Array.isArray(result.data) ? result.data : [];

  if (parsed.list) {
    const normalizedList = normalizeLookupValue(parsed.list);
    tasks = tasks.filter((task) => normalizeLookupValue(task.list?.name) === normalizedList);
  }

  const limit = parsed.limit || 20;

  return {
    action: "list",
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    list: parsed.list || null,
    result: tasks.slice(0, limit)
  };
}

export async function handleListWorkspaces() {
  const result = await listWorkspaces();
  return {
    action: "list_workspaces",
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
    action: "list_lists",
    workspace: workspace.name,
    workspaceId: project.workspaceId,
    result: result.data || result.stdout
  };
}

export async function handleHelp() {
  return {
    action: "help",
    result: getSlackHelpText()
  };
}

export function parseHumanCommand(text, fallbackWorkspace) {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    throw new Error("Command text is empty.");
  }

  if (/^(help|commands|\?)$/i.test(trimmed)) {
    return {
      action: "help",
      payload: {}
    };
  }

  const normalizedSpaces = trimmed.replace(/\s+/g, " ").trim();

  function unsupportedFormatError(suggestion) {
    const base =
      "Unsupported command format. Try help, create, bulk create, search, list tasks, status, update, move, or comment. Example: '/blue help'.";

    if (!suggestion) {
      throw new Error(base);
    }

    throw new Error(`${base} Did you mean: '${suggestion}'?`);
  }

  function parseBulkTitles(rawList) {
    const raw = String(rawList || "").trim();
    if (!raw) {
      throw new Error(
        "Bulk create needs at least one task. Example: 'bulk create in DataCX - Active: Task A | Task B | Task C'."
      );
    }

    const lineItems = raw
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").replace(/^\[\s?\]\s+/, "").trim())
      .filter(Boolean);

    const sourceItems =
      lineItems.length > 1
        ? lineItems
        : raw
            .split(/\s*\|\s*|\s*;\s*/)
            .map((item) => item.trim())
            .filter(Boolean);

    const uniqueItems = [];
    for (const item of sourceItems) {
      if (!uniqueItems.includes(item)) {
        uniqueItems.push(item);
      }
    }

    if (!uniqueItems.length) {
      throw new Error(
        "I couldn't find any task titles in that bulk create command. Separate tasks with new lines, `|`, or `;`."
      );
    }

    return uniqueItems;
  }

  function parseMetadataToken(token) {
    const match = String(token || "")
      .trim()
      .match(/^(title|desc|description|assignee|assignees)\s*:\s*(.+)$/i);
    if (!match) {
      return null;
    }

    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (!value) {
      return null;
    }

    if (key === "title") {
      return { key: "title", value };
    }

    if (key === "desc" || key === "description") {
      return { key: "description", value };
    }

    return {
      key: "assignees",
      value: value
        .split(/\s*,\s*/)
        .map((item) => item.trim())
        .filter(Boolean)
    };
  }

  function parseCreateBody(rawBody) {
    const segments = String(rawBody || "")
      .split("|")
      .map((segment) => segment.trim())
      .filter(Boolean);

    const titleParts = [];
    const metadata = {};

    for (const segment of segments) {
      const parsedToken = parseMetadataToken(segment);
      if (!parsedToken) {
        titleParts.push(segment);
        continue;
      }

      metadata[parsedToken.key] = parsedToken.value;
    }

    const title = (metadata.title || titleParts.join(" | ")).trim();
    if (!title) {
      throw new Error(
        "Create needs a task title. Example: 'create in DataCX - Active: Fix login timeout | desc: Session expires after 5 min | assignee: Akash H'."
      );
    }

    return {
      title,
      description: metadata.description || "",
      assignees: metadata.assignees || []
    };
  }

  function deriveTitleFromDescription(description) {
    const cleaned = String(description || "").replace(/\s+/g, " ").trim();
    if (!cleaned) {
      return "";
    }

    const sentenceMatch = cleaned.match(/^(.+?[.!?])(?:\s|$)/);
    const candidate = (sentenceMatch ? sentenceMatch[1] : cleaned).replace(/[.!?]+$/, "").trim();
    const words = candidate.split(" ").filter(Boolean);

    if (words.length <= 8 && candidate.length <= 60) {
      return candidate;
    }

    const shortWords = words.slice(0, 8).join(" ").trim();
    if (shortWords.length <= 60) {
      return `${shortWords}...`;
    }

    return `${candidate.slice(0, 57).trimEnd()}...`;
  }

  function parseSimpleCreateSegments(rawBody) {
    const segments = String(rawBody || "")
      .split("|")
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (segments.length < 2) {
      throw new Error(
        "Use this format for quick create: 'create a task in DataCX - Active | Task description | Assignee'."
      );
    }

    const [description, assigneeSegment] = segments;
    const assignees = assigneeSegment
      .split(/\s*,\s*/)
      .map((item) => item.trim())
      .filter(Boolean);

    const payload = {
      title: deriveTitleFromDescription(description),
      description: description.trim(),
      assignees
    };

    validateCreateRequirements(payload);
    return payload;
  }

  function parseBulkBody(rawBody) {
    const raw = String(rawBody || "");
    const splitLines = raw.split(/\r?\n/);
    const header = splitLines[0] || "";
    const bodyLines = splitLines.slice(1);

    const headerSegments = header
      .split("|")
      .map((segment) => segment.trim())
      .filter(Boolean);

    const metadata = {};
    const contentSegments = [];
    for (const segment of headerSegments) {
      const parsedToken = parseMetadataToken(segment);
      if (parsedToken) {
        metadata[parsedToken.key] = parsedToken.value;
      } else {
        contentSegments.push(segment);
      }
    }

    const content =
      bodyLines.filter((line) => line.trim()).length > 0
        ? bodyLines.join("\n")
        : contentSegments.join(" | ");

    const titles = parseBulkTitles(content);
    return {
      titles,
      description: metadata.description || "",
      assignees: metadata.assignees || []
    };
  }

  function parseUpdateSegments(rawBody) {
    const segments = String(rawBody || "")
      .split("|")
      .map((segment) => segment.trim())
      .filter(Boolean);

    const payload = {};
    for (const segment of segments) {
      const parsedToken = parseMetadataToken(segment);
      if (!parsedToken) {
        continue;
      }

      payload[parsedToken.key] = parsedToken.value;
    }

    if (!payload.title && !payload.description && !payload.assignees?.length) {
      throw new Error(
        "Update needs at least one field. Example: 'update in DataCX - Active: checkout footer | desc: Repro on iPhone Safari | assignee: Akash H'."
      );
    }

    return payload;
  }

  function validateCreateRequirements(payload, { bulk = false } = {}) {
    if (!payload.description) {
      throw new Error(
        bulk
          ? "Bulk create requires a shared description. Example: 'bulk create in DataCX - Active: desc: Q3 launch tasks | assignee: Akash H | Task A ; Task B'."
          : "Create requires a description. Example: 'create in DataCX - Active: Fix login timeout | desc: Session expires after 5 min | assignee: Akash H'."
      );
    }

    if (!payload.assignees?.length) {
      throw new Error(
        bulk
          ? "Bulk create requires an assignee. Example: 'bulk create in DataCX - Active: desc: Q3 launch tasks | assignee: Akash H | Task A ; Task B'."
          : "Create requires an assignee. Example: 'create in DataCX - Active: Fix login timeout | desc: Session expires after 5 min | assignee: Akash H'."
      );
    }
  }

  const bulkCreateMatch = trimmed.match(/^(?:bulk\s+create|create\s+tasks?)(?:\s+in\s+(.+?))?\s*:\s*([\s\S]+)$/i);
  if (bulkCreateMatch) {
    if (!bulkCreateMatch[1] && !fallbackWorkspace) {
      throw new Error(
        "Please choose a workspace in the bulk create command. Example: 'bulk create in DataCX - Active: Task A | Task B'."
      );
    }

    const parsedBody = parseBulkBody(bulkCreateMatch[2]);
    validateCreateRequirements(parsedBody, { bulk: true });
    return {
      action: "bulk_create",
      payload: {
        workspace: bulkCreateMatch[1]?.trim() || fallbackWorkspace,
        ...parsedBody
      }
    };
  }

  const simpleCreateMatch = trimmed.match(/^create\s+(?:a\s+)?task\s+in\s+(.+?)\s*\|\s*([\s\S]+)$/i);
  if (simpleCreateMatch) {
    const parsedBody = parseSimpleCreateSegments(simpleCreateMatch[2]);
    return {
      action: "create",
      payload: {
        workspace: simpleCreateMatch[1].trim(),
        ...parsedBody
      }
    };
  }

  const createMatch = trimmed.match(/^create(?:\s+in\s+(.+?))?\s*:\s*(.+)$/i);
  if (createMatch) {
    if (!createMatch[1] && !fallbackWorkspace) {
      throw new Error(
        "Please choose a workspace in the command. Example: 'create in DataCX - Active: Fix login timeout'."
      );
    }

    const parsedBody = parseCreateBody(createMatch[2]);
    validateCreateRequirements(parsedBody);
    return {
      action: "create",
      payload: {
        workspace: createMatch[1]?.trim() || fallbackWorkspace,
        ...parsedBody
      }
    };
  }

  const listMatch = trimmed.match(/^list\s+tasks?(?:\s+in\s+(.+?))?(?:\s*:\s*(.+))?$/i);
  if (listMatch) {
    const workspace = listMatch[1]?.trim() || fallbackWorkspace;
    if (!workspace) {
      throw new Error("Please choose a workspace. Example: 'list tasks in DataCX - Active'.");
    }

    return {
      action: "list",
      payload: {
        workspace,
        list: listMatch[2]?.trim() || undefined
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

  const statusByIdMatch = trimmed.match(/^status\s+(\S+)$/i);
  if (statusByIdMatch) {
    return {
      action: "status",
      payload: {
        recordId: statusByIdMatch[1]
      }
    };
  }

  const statusByQueryMatch = trimmed.match(/^status(?:\s+in\s+(.+?))?\s*:\s*(.+)$/i);
  if (statusByQueryMatch) {
    const workspace = statusByQueryMatch[1]?.trim() || fallbackWorkspace;
    if (!workspace) {
      throw new Error("Please choose a workspace. Example: 'status in DataCX - Active: checkout'.");
    }

    return {
      action: "status",
      payload: {
        workspace,
        taskQuery: statusByQueryMatch[2].trim()
      }
    };
  }

  const updateByIdMatch = trimmed.match(/^update\s+(\S+)\s*\|\s*(.+)$/i);
  if (updateByIdMatch) {
    return {
      action: "update",
      payload: {
        recordId: updateByIdMatch[1],
        ...parseUpdateSegments(updateByIdMatch[2])
      }
    };
  }

  const updateByQueryMatch = trimmed.match(/^update(?:\s+in\s+(.+?))?\s*:\s*(.+?)\s*\|\s*(.+)$/i);
  if (updateByQueryMatch) {
    const workspace = updateByQueryMatch[1]?.trim() || fallbackWorkspace;
    if (!workspace) {
      throw new Error("Please choose a workspace. Example: 'update in DataCX - Active: checkout | desc: ...'.");
    }

    return {
      action: "update",
      payload: {
        workspace,
        taskQuery: updateByQueryMatch[2].trim(),
        ...parseUpdateSegments(updateByQueryMatch[3])
      }
    };
  }

  const commentByQueryMatch = trimmed.match(/^comment(?:\s+in\s+(.+?))?\s*:\s*(.+?)\s*\|\s*(.+)$/i);
  if (commentByQueryMatch) {
    const workspace = commentByQueryMatch[1]?.trim() || fallbackWorkspace;
    if (!workspace) {
      throw new Error("Please choose a workspace. Example: 'comment in DataCX - Active: checkout | Please verify'.");
    }

    return {
      action: "comment",
      payload: {
        workspace,
        taskQuery: commentByQueryMatch[2].trim(),
        text: commentByQueryMatch[3].trim()
      }
    };
  }

  const commentByIdMatch = trimmed.match(/^comment\s+(\S+)\s*:\s*(.+)$/i);
  if (commentByIdMatch) {
    return {
      action: "comment",
      payload: {
        recordId: commentByIdMatch[1],
        text: commentByIdMatch[2].trim()
      }
    };
  }

  const moveByIdMatch = trimmed.match(/^move\s+(\S+)\s+to\s+(.+)$/i);
  if (moveByIdMatch) {
    return {
      action: "move",
      payload: {
        recordId: moveByIdMatch[1],
        list: moveByIdMatch[2].trim()
      }
    };
  }

  const moveByQueryMatch = trimmed.match(/^move(?:\s+in\s+(.+?))?\s*:\s*(.+?)\s*\|\s*(.+)$/i);
  if (moveByQueryMatch) {
    const workspace = moveByQueryMatch[1]?.trim() || fallbackWorkspace;
    if (!workspace) {
      throw new Error("Please choose a workspace. Example: 'move in DataCX - Active: checkout | QA'.");
    }

    return {
      action: "move",
      payload: {
        workspace,
        taskQuery: moveByQueryMatch[2].trim(),
        list: moveByQueryMatch[3].trim()
      }
    };
  }

  unsupportedFormatError(null);
}

export async function dispatchHumanCommand(text, fallbackWorkspace) {
  const command = parseHumanCommand(text, fallbackWorkspace);
  return dispatchParsedCommand(command);
}

export async function dispatchParsedCommand(command) {
  switch (command.action) {
    case "help":
      return handleHelp();
    case "create":
      return handleCreateTask(command.payload);
    case "bulk_create":
      return handleBulkCreateTask(command.payload);
    case "comment":
      return handleCommentTask(command.payload);
    case "move":
      return handleMoveTask(command.payload);
    case "search":
      return handleSearchTasks(command.payload);
    case "status":
      return handleStatusTask(command.payload);
    case "update":
      return handleUpdateTask(command.payload);
    case "list":
      return handleListTasks(command.payload);
    default:
      throw new Error(`Unsupported action '${command.action}'.`);
  }
}
