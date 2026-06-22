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

const importTaskRowSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assignee: z.string().optional(),
  list: z.string().optional()
});

const bulkImportTaskSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  rows: z.array(importTaskRowSchema).min(1).max(200)
});

const updateTaskSchema = z.object({
  project: z.string().optional(),
  projectId: z.string().optional(),
  workspace: z.string().optional(),
  workspaceId: z.string().optional(),
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
  projectId: z.string().optional(),
  workspace: z.string().optional(),
  workspaceId: z.string().optional(),
  recordId: z.string().min(1).optional(),
  taskQuery: z.string().min(1).optional(),
  list: z.string().optional(),
  listId: z.string().optional()
});

const commentTaskSchema = z.object({
  project: z.string().optional(),
  projectId: z.string().optional(),
  workspace: z.string().optional(),
  workspaceId: z.string().optional(),
  recordId: z.string().min(1).optional(),
  taskQuery: z.string().min(1).optional(),
  text: z.string().min(1)
});

const searchTaskSchema = z.object({
  project: z.string().optional(),
  projectId: z.string().optional(),
  workspace: z.string().optional(),
  workspaceId: z.string().optional(),
  query: z.string().min(1),
  assignee: z.string().optional(),
  done: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional()
});

const statusTaskSchema = z.object({
  project: z.string().optional(),
  projectId: z.string().optional(),
  workspace: z.string().optional(),
  workspaceId: z.string().optional(),
  recordId: z.string().min(1).optional(),
  taskQuery: z.string().min(1).optional()
});

const listTaskSchema = z.object({
  project: z.string().optional(),
  projectId: z.string().optional(),
  workspace: z.string().optional(),
  workspaceId: z.string().optional(),
  allWorkspaces: z.boolean().optional(),
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
    "/blue create in DataCX - Active: Checkout footer bug | Checkout button overlaps footer on mobile Safari | Akash H",
    "",
    "2. Bulk create tasks",
    "/blue bulk create in DataCX - Active:",
    "Checkout footer bug | Checkout button overlaps footer on mobile Safari | Akash H",
    "Login bug | User gets redirected back to login on Safari | Kunal",
    "",
    "3. Bulk create with shared description and assignee",
    "/blue bulk create in DataCX - Active: desc: Sprint intake | assignee: Akash H | Fix login ; Add QA checklist ; Review handoff",
    "",
    "4. Bulk create with shared assignee and description-derived titles",
    "/blue create in DataCX - Active: Akash H | Fix login timeout on Safari ; Add QA checklist ; Review handoff",
    "",
    "5. Search tasks",
    "/blue search in DataCX - Active: checkout",
    "/blue search in DataCX - Active: checkout | assignee: Akash H",
    "",
    "6. List tasks",
    "/blue list tasks in DataCX - Active",
    "/blue list tasks in DataCX - Active: In Progress",
    "/blue list tasks in DataCX - Active | assignee: Akash H",
    "/blue tasks for Akash H in DataCX - Active",
    "/blue tasks for Akash H in DataCX - Active: QA",
    "/blue tasks for Akash H in all workspaces",
    "",
    "7. Check task status",
    "/blue status in DataCX - Active: checkout footer",
    "",
    "8. Update a task",
    "/blue update in DataCX - Active: checkout footer | desc: Repro on iPhone 14 Safari | assignee: Akash H",
    "",
    "9. Move a task",
    "/blue move in DataCX - Active: checkout footer | QA",
    "",
    "10. Comment on a task",
    "/blue comment in DataCX - Active: checkout footer | Please verify on iPhone 14",
    "",
    "Tips:",
    "- Preferred single create format: create in <project>: title | description | assignee",
    "- Preferred bulk create format: bulk create in <project>: one task per line as title | description | assignee",
    "- Shared assignee shorthand: create in <project>: Assignee | description 1 ; description 2 ; description 3",
    "- I will generate a shorter title automatically when you use the shared-assignee shorthand",
    "- Search is case-insensitive and fuzzy, and can match title plus description text",
    "- You can filter search or list results by assignee",
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

function sortTasksForSlack(tasks = []) {
  const backlogNames = new Set(["backlog"]);

  return [...tasks].sort((left, right) => {
    const leftList = normalizeLookupValue(left.list?.name);
    const rightList = normalizeLookupValue(right.list?.name);
    const leftIsBacklog = backlogNames.has(leftList);
    const rightIsBacklog = backlogNames.has(rightList);

    if (leftIsBacklog !== rightIsBacklog) {
      return leftIsBacklog ? 1 : -1;
    }

    return (
      new Date(right.updatedAt || right.createdAt || 0).getTime() -
      new Date(left.updatedAt || left.createdAt || 0).getTime()
    );
  });
}

async function resolveWorkspaceById(workspaceId) {
  if (!workspaceId) {
    return null;
  }

  try {
    return await resolveWorkspace(workspaceId);
  } catch {
    return null;
  }
}

function withWorkspaceSlug(task, workspace) {
  if (!task || task.list?.workspaceSlug || !workspace?.slug) {
    return task;
  }

  return {
    ...task,
    list: task.list
      ? {
          ...task.list,
          workspaceSlug: workspace.slug
        }
      : task.list
  };
}

function withWorkspaceSlugForTasks(tasks = [], workspace) {
  return Array.isArray(tasks) ? tasks.map((task) => withWorkspaceSlug(task, workspace)) : tasks;
}

async function resolveExistingTaskContext(input = {}) {
  if (!input.recordId) {
    throw new Error("Task ID is required.");
  }

  const recordResult = await getRecord(input.recordId, {
    projectId: input.workspaceId || input.projectId || undefined
  });
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
      name: record.list.workspace || input.workspace || "Blue",
      slug: record.list.workspaceSlug || ""
    },
    list,
    record: withWorkspaceSlug(record, {
      slug: record.list.workspaceSlug || ""
    })
  };
}

async function resolveTargetContext(input = {}) {
  const configuredProject =
    getProjectIfConfigured(input.project) ||
    (!input.workspace && config.projectConfig.defaultProject
      ? getProjectIfConfigured(config.projectConfig.defaultProject)
      : null);

  if (configuredProject) {
    const workspace = await resolveWorkspaceById(configuredProject.workspaceId);
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
        name: workspace?.name || configuredProject.name,
        slug: workspace?.slug || ""
      },
      list
    };
  }

  if (input.workspaceId && input.workspace) {
    const workspace = await resolveWorkspaceById(input.workspaceId);
    const project = {
      name: workspace?.name || input.workspace,
      company: config.blueDefaultCompany,
      workspaceId: input.workspaceId,
      listId: null,
      defaultAssignees: [],
      defaultTags: []
    };
    const list =
      input.listId || input.list || input.recordId
        ? await resolveList(input.workspaceId, input.listId || input.list || null, project)
        : null;

    return {
      project,
      workspace: {
        id: input.workspaceId,
        name: workspace?.name || input.workspace,
        slug: workspace?.slug || ""
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
    workspaceSlug: target.workspace.slug || "",
    list: list.name,
    result: withWorkspaceSlug(result.data || result.stdout, target.workspace)
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
    workspaceSlug: target.workspace.slug || "",
    list: list.name,
    result: {
      createdCount: created.length,
      created: withWorkspaceSlugForTasks(created, target.workspace)
    }
  };
}

export async function handleBulkImportTask(input) {
  const parsed = bulkImportTaskSchema.parse(input);
  const target = await resolveTargetContext(parsed);
  const defaultList = await resolveList(target.project.workspaceId, null, target.project);
  const created = [];
  const errors = [];
  const warnings = [];

  for (let index = 0; index < parsed.rows.length; index += 1) {
    const row = parsed.rows[index];

    try {
      let assigneeIds = [];

      if (row.assignee) {
        try {
          assigneeIds = (await resolveAssignees(target.project.workspaceId, [row.assignee])).map(
            (user) => user.id
          );
        } catch (error) {
          warnings.push({
            rowNumber: index + 2,
            title: row.title,
            message: `Assignee '${row.assignee}' could not be resolved. Task was created without an assignee.`
          });
        }
      }

      const list = row.list
        ? await resolveList(target.project.workspaceId, row.list, target.project)
        : defaultList;
      const result = await createRecord(target.project, {
        title: row.title,
        description: row.description || "",
        assignees: assigneeIds,
        listId: list.id,
        tagIds: target.project.defaultTags
      });

      created.push(result.data || result.stdout);
    } catch (error) {
      errors.push({
        rowNumber: index + 2,
        title: row.title,
        message: error.message
      });
    }
  }

  return {
    action: "bulk_import",
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    workspaceSlug: target.workspace.slug || "",
    list: defaultList.name,
    result: {
      createdCount: created.length,
      errorCount: errors.length,
      warningCount: warnings.length,
      created: withWorkspaceSlugForTasks(created, target.workspace),
      errors,
      warnings
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
    workspaceSlug: target.workspace.slug || "",
    result: withWorkspaceSlug(result.data || result.stdout, target.workspace)
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
    workspaceSlug: target.workspace.slug || "",
    list: list.name,
    result: withWorkspaceSlug(result.data || result.stdout, target.workspace)
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
    workspaceSlug: target.workspace.slug || "",
    recordId: parsed.recordId,
    comment: result.data || result.stdout,
    result: withWorkspaceSlug(
      target.record ||
        (
          await getRecord(parsed.recordId, {
            projectId: target.project.workspaceId
          })
        ).data,
      target.workspace
    )
  };
}

export async function handleSearchTasks(input) {
  const parsed = searchTaskSchema.parse(input);
  const target = await resolveTargetContext(parsed);
  const assigneeId = parsed.assignee
    ? (await resolveAssignees(target.project.workspaceId, [parsed.assignee]))[0]?.id
    : undefined;
  const result = await searchRecords(target.project, parsed.query, {
    assignee: assigneeId,
    done: parsed.done,
    limit: parsed.limit || 5
  });

  return {
    action: "search",
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    workspaceSlug: target.workspace.slug || "",
    query: parsed.query,
    assignee: parsed.assignee,
    result: withWorkspaceSlugForTasks(result.data || result.stdout, target.workspace)
  };
}

export async function handleStatusTask(input) {
  const parsed = statusTaskSchema.parse(input);
  if (!parsed.recordId) {
    throw new Error("Please select a task first before checking its status.");
  }

  const record = (
    await getRecord(parsed.recordId, {
      projectId: parsed.workspaceId || parsed.projectId || undefined
    })
  ).data;

  return {
    action: "status",
    project: record.list?.workspace || parsed.workspace || "Blue",
    workspace: record.list?.workspace || parsed.workspace || "Blue",
    workspaceId: record.list?.workspaceId || "",
    workspaceSlug: record.list?.workspaceSlug || "",
    result: record
  };
}

export async function handleListTasks(input = {}) {
  const parsed = listTaskSchema.parse(input);

  if (parsed.allWorkspaces) {
    if (!parsed.assignee) {
      throw new Error("Please specify an assignee for all-workspaces task listing.");
    }

    const workspaceResult = await listWorkspaces();
    const workspaces = (Array.isArray(workspaceResult.data) ? workspaceResult.data : []).filter(
      (workspace) => !workspace.archived
    );

    const tasks = [];
    let matchedWorkspaceCount = 0;

    for (const workspace of workspaces) {
      let assigneeId;

      try {
        assigneeId = (await resolveAssignees(workspace.id, [parsed.assignee]))[0]?.id;
      } catch (error) {
        if (String(error.message || "").includes("was not found in this workspace")) {
          continue;
        }

        throw error;
      }

      if (!assigneeId) {
        continue;
      }

      matchedWorkspaceCount += 1;

      const project = {
        name: workspace.name,
        company: config.blueDefaultCompany,
        workspaceId: workspace.id,
        listId: null,
        defaultAssignees: [],
        defaultTags: []
      };

      const result = await listRecords(project, {
        done: parsed.done,
        assignee: assigneeId
      });

      let workspaceTasks = Array.isArray(result.data) ? result.data : [];

      if (parsed.list) {
        const normalizedList = normalizeLookupValue(parsed.list);
        workspaceTasks = workspaceTasks.filter(
          (task) => normalizeLookupValue(task.list?.name) === normalizedList
        );
      }

      tasks.push(...workspaceTasks);
    }

    if (!matchedWorkspaceCount) {
      throw new Error(
        `I couldn't find assignee '${parsed.assignee}' in any accessible Blue workspace.`
      );
    }

    const limit = parsed.limit || 50;

    return {
      action: "list",
      project: "All Workspaces",
      workspace: "All Workspaces",
      workspaceId: "",
      workspaceSlug: "",
      allWorkspaces: true,
      list: parsed.list || null,
      assignee: parsed.assignee,
      matchedWorkspaceCount,
      result: sortTasksForSlack(tasks).slice(0, limit)
    };
  }

  const target = await resolveTargetContext(parsed);
  const assigneeId = parsed.assignee
    ? (await resolveAssignees(target.project.workspaceId, [parsed.assignee]))[0]?.id
    : undefined;
  const result = await listRecords(target.project, {
    done: parsed.done,
    assignee: assigneeId
  });

  let tasks = Array.isArray(result.data) ? result.data : [];

  if (parsed.list) {
    const normalizedList = normalizeLookupValue(parsed.list);
    tasks = tasks.filter((task) => normalizeLookupValue(task.list?.name) === normalizedList);
  }

  tasks = sortTasksForSlack(tasks);

  const limit = parsed.limit || 20;

  return {
    action: "list",
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    workspaceSlug: target.workspace.slug || "",
    list: parsed.list || null,
    assignee: parsed.assignee,
    result: withWorkspaceSlugForTasks(tasks.slice(0, limit), target.workspace)
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

  function parseStructuredTaskLine(rawLine, rowLabel) {
    const parts = String(rawLine || "")
      .split("|")
      .map((part) => part.trim());

    if (parts.length < 3) {
      throw new Error(`${rowLabel} is invalid. Use '<task title> | <description> | <assignee>'.`);
    }

    const [title, description, assignee] = parts;
    const list = parts[3]?.trim() || "";

    if (!title) {
      throw new Error(`${rowLabel} is missing a task title.`);
    }
    if (!description) {
      throw new Error(`${rowLabel} is missing a description.`);
    }
    if (!assignee) {
      throw new Error(`${rowLabel} is missing an assignee.`);
    }

    return {
      title,
      description,
      assignee,
      list
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

  function parseImportBody(rawBody) {
    const rows = String(rawBody || "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((row) => row.trim())
      .filter(Boolean);

    if (!rows.length) {
      throw new Error(
        "Bulk import needs at least one row. Use: '<task title> | <description> | <assignee>'."
      );
    }

    return rows.map((row, index) => parseStructuredTaskLine(row, `Row ${index + 1}`));
  }

  function parseSharedAssigneeBulkBody(rawBody) {
    const [assigneePart, descriptionsPart] = String(rawBody || "").split(/\s*\|\s*/, 2);

    if (!assigneePart || !descriptionsPart) {
      throw new Error(
        "Shared assignee bulk create should look like: 'create in DataCX - Active: Akash H | Task description 1 ; Task description 2'."
      );
    }

    const assignee = assigneePart.trim();
    const descriptions = descriptionsPart
      .split(/\s*;\s*/)
      .map((item) => item.trim())
      .filter(Boolean);

    if (!descriptions.length) {
      throw new Error("Please include at least one task description after the assignee.");
    }

    return descriptions.map((description) => ({
      title: deriveTitleFromDescription(description),
      description,
      assignee,
      list: ""
    }));
  }

  function looksLikeStructuredBulkRows(rawBody) {
    const rows = String(rawBody || "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((row) => row.trim())
      .filter(Boolean);

    return rows.length > 0 && rows.every((row) => row.split("|").length >= 3);
  }

  function looksLikeSharedAssigneeBulk(rawBody) {
    const body = String(rawBody || "");
    const parts = body.split("|");
    if (parts.length !== 2) {
      return false;
    }

    return parts[1].includes(";");
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

  function parseSingleAssigneeFilter(rawBody, { allowPrimary = true } = {}) {
    const segments = String(rawBody || "")
      .split("|")
      .map((segment) => segment.trim())
      .filter(Boolean);

    const payload = {};
    const primary = [];

    for (const segment of segments) {
      const parsedToken = parseMetadataToken(segment);
      if (!parsedToken) {
        if (allowPrimary) {
          primary.push(segment);
        }
        continue;
      }

      if (parsedToken.key === "assignees") {
        if (parsedToken.value.length > 1) {
          throw new Error("Please use one assignee filter at a time for search or list commands.");
        }

        payload.assignee = parsedToken.value[0];
      }
    }

    return {
      primary: primary.join(" | ").trim(),
      assignee: payload.assignee
    };
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

    if (looksLikeStructuredBulkRows(bulkCreateMatch[2])) {
      return {
        action: "bulk_import",
        payload: {
          workspace: bulkCreateMatch[1]?.trim() || fallbackWorkspace,
          rows: parseImportBody(bulkCreateMatch[2])
        }
      };
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

  const importMatch = trimmed.match(/^(?:bulk\s+import\s+tasks|import\s+tasks|bulk\s+import)(?:\s+in\s+(.+?))?\s*:\s*([\s\S]+)$/i);
  if (importMatch) {
    const workspace = importMatch[1]?.trim() || fallbackWorkspace;
    if (!workspace) {
      throw new Error(
        "Please choose a workspace in the import command. Example: 'import tasks in datacx: <paste rows>'."
      );
    }

    return {
      action: "bulk_import",
      payload: {
        workspace,
        rows: parseImportBody(importMatch[2])
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

    if (looksLikeStructuredBulkRows(createMatch[2])) {
      return {
        action: "bulk_import",
        payload: {
          workspace: createMatch[1]?.trim() || fallbackWorkspace,
          rows: parseImportBody(createMatch[2])
        }
      };
    }

    if (looksLikeSharedAssigneeBulk(createMatch[2])) {
      return {
        action: "bulk_import",
        payload: {
          workspace: createMatch[1]?.trim() || fallbackWorkspace,
          rows: parseSharedAssigneeBulkBody(createMatch[2])
        }
      };
    }

    const structuredParts = createMatch[2].split("|").map((segment) => segment.trim()).filter(Boolean);
    if (structuredParts.length >= 3) {
      return {
        action: "create",
        payload: {
          workspace: createMatch[1]?.trim() || fallbackWorkspace,
          title: structuredParts[0],
          description: structuredParts[1],
          assignees: [structuredParts[2]]
        }
      };
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

  const listMatch = trimmed.match(/^list\s+tasks?(?:\s+in\s+(.+?))?(?:\s*[:|]\s*(.+))?$/i);
  if (listMatch) {
    const workspace = listMatch[1]?.trim() || fallbackWorkspace;
    if (!workspace) {
      throw new Error("Please choose a workspace. Example: 'list tasks in DataCX - Active'.");
    }

    const parsedFilters = parseSingleAssigneeFilter(listMatch[2] || "", { allowPrimary: true });

    return {
      action: "list",
      payload: {
        workspace,
        list: parsedFilters.primary || undefined,
        assignee: parsedFilters.assignee
      }
    };
  }

  const tasksForMatch = trimmed.match(/^tasks\s+for\s+(.+?)(?:\s+in\s+(.+?))?(?:\s*:\s*(.+))?$/i);
  if (tasksForMatch) {
    const workspace = tasksForMatch[2]?.trim() || fallbackWorkspace;
    if (!workspace) {
      throw new Error("Please choose a workspace. Example: 'tasks for Akash H in DataCX - Active'.");
    }
    const allWorkspaces = normalizeLookupValue(workspace) === "all workspaces";

    return {
      action: "list",
      payload: {
        workspace: allWorkspaces ? undefined : workspace,
        allWorkspaces,
        assignee: tasksForMatch[1].trim(),
        list: tasksForMatch[3]?.trim() || undefined,
        done: false
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

    const parsedFilters = parseSingleAssigneeFilter(searchMatch[2], { allowPrimary: true });
    if (!parsedFilters.primary) {
      throw new Error(
        "Please include a search term. Example: 'search in DataCX - Active: checkout | assignee: Akash H'."
      );
    }

    return {
      action: "search",
      payload: {
        workspace: searchMatch[1]?.trim() || fallbackWorkspace,
        query: parsedFilters.primary,
        assignee: parsedFilters.assignee
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
    case "bulk_import":
      return handleBulkImportTask(command.payload);
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
