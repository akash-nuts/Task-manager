import { z } from "zod";
import {
  createComment,
  createRecord,
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
  const resolved = await resolveCreateDefaults(target, parsed);
  const result = await createRecord(target.project, {
    ...parsed,
    listId: parsed.listId || target.list.id,
    assignees: resolved.assigneeIds,
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

export async function handleBulkCreateTask(input) {
  const parsed = bulkCreateTaskSchema.parse(input);
  const target = await resolveTargetContext(parsed);
  const resolved = await resolveCreateDefaults(target, parsed);
  const titles = parsed.titles.map((title) => title.trim()).filter(Boolean);
  const created = [];

  for (const title of titles) {
    const result = await createRecord(target.project, {
      ...parsed,
      title,
      listId: parsed.listId || target.list.id,
      assignees: resolved.assigneeIds,
      tagIds: parsed.tagIds?.length ? parsed.tagIds : target.project.defaultTags
    });

    created.push(result.data || result.stdout);
  }

  return {
    project: target.project.name,
    workspace: target.workspace.name,
    workspaceId: target.project.workspaceId,
    list: target.list.name,
    result: {
      createdCount: created.length,
      created
    }
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

  const normalizedSpaces = trimmed.replace(/\s+/g, " ").trim();

  function workspaceSuggestion(workspace, actionText) {
    return `${actionText} in ${workspace}: `;
  }

  function unsupportedFormatError(suggestion) {
    const base =
      "Unsupported command format. Try 'create a task in DataCX - Active | Fix login timeout on Safari login page | Akash H', 'create in DataCX - Active: Fix login bug | desc: ... | assignee: Akash H', 'bulk create in DataCX - Active: desc: ... | assignee: Akash H | Task A ; Task B', or 'search in 4ay-AI-CRM: onboarding'.";

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
    const match = String(token || "").trim().match(/^(desc|description|assignee|assignees)\s*:\s*(.+)$/i);
    if (!match) {
      return null;
    }

    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (!value) {
      return null;
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

    const title = titleParts.join(" | ").trim();
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

  const naturalBulkCreateMatch = normalizedSpaces.match(/^(?:bulk\s+create|create\s+tasks?)\s+(.+?)\s+in\s+(.+)$/i);
  if (naturalBulkCreateMatch) {
    const parsedBody = parseBulkBody(naturalBulkCreateMatch[1]);
    validateCreateRequirements(parsedBody, { bulk: true });
    return {
      action: "bulk_create",
      payload: {
        workspace: naturalBulkCreateMatch[2].trim(),
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

  const naturalCreateMatch = normalizedSpaces.match(/^create\s+(.+?)\s+in\s+(.+)$/i);
  if (naturalCreateMatch) {
    const parsedBody = parseCreateBody(naturalCreateMatch[1]);
    validateCreateRequirements(parsedBody);
    return {
      action: "create",
      payload: {
        workspace: naturalCreateMatch[2].trim(),
        ...parsedBody
      }
    };
  }

  const createMissingColonMatch = normalizedSpaces.match(/^create\s+in\s+(.+?)\s+(.+)$/i);
  if (createMissingColonMatch) {
    const parsedBody = parseCreateBody(createMissingColonMatch[2]);
    validateCreateRequirements(parsedBody);
    return {
      action: "create",
      payload: {
        workspace: createMissingColonMatch[1].trim(),
        ...parsedBody
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

  const naturalCommentMatch = normalizedSpaces.match(/^comment\s+on\s+(\S+)\s+(.+)$/i);
  if (naturalCommentMatch) {
    return {
      action: "comment",
      payload: {
        workspace: fallbackWorkspace,
        recordId: naturalCommentMatch[1],
        text: naturalCommentMatch[2].trim()
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

  const naturalMoveMatch = normalizedSpaces.match(/^move\s+task\s+(\S+)\s+to\s+(.+)$/i);
  if (naturalMoveMatch) {
    return {
      action: "move",
      payload: {
        workspace: fallbackWorkspace,
        recordId: naturalMoveMatch[1],
        list: naturalMoveMatch[2].trim()
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

  const naturalSearchMatch = normalizedSpaces.match(/^search\s+(.+?)\s+in\s+(.+)$/i);
  if (naturalSearchMatch) {
    return {
      action: "search",
      payload: {
        workspace: naturalSearchMatch[2].trim(),
        query: naturalSearchMatch[1].trim()
      }
    };
  }

  const createWorkspaceGuess = normalizedSpaces.match(/^create\s+(.+)$/i);
  if (createWorkspaceGuess && fallbackWorkspace) {
    unsupportedFormatError(`${workspaceSuggestion(fallbackWorkspace, "create")}${createWorkspaceGuess[1].trim()}`);
  }

  const searchWorkspaceGuess = normalizedSpaces.match(/^search\s+(.+)$/i);
  if (searchWorkspaceGuess && fallbackWorkspace) {
    unsupportedFormatError(`${workspaceSuggestion(fallbackWorkspace, "search")}${searchWorkspaceGuess[1].trim()}`);
  }

  unsupportedFormatError(null);
}

export async function dispatchHumanCommand(text, fallbackWorkspace) {
  const command = parseHumanCommand(text, fallbackWorkspace);
  return dispatchParsedCommand(command);
}

export async function dispatchParsedCommand(command) {
  switch (command.action) {
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
    default:
      throw new Error(`Unsupported action '${command.action}'.`);
  }
}
