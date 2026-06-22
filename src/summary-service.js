import { config } from "./config.js";
import { listRecords, listWorkspaces, resolveWorkspace } from "./blue-api.js";
import { cleanupSummaryEvents, getSummaryEventsBetween, isSummaryStoreConfigured } from "./summary-store.js";

function normalizeLookupValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatAssigneeList(assignees = []) {
  const names = assignees
    .map((assignee) => assignee.fullName || assignee.email || assignee.id || "")
    .filter(Boolean);

  return names.length ? names.join(", ") : "Unassigned";
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const unique = [];

  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function isListMatch(listName, candidates) {
  const normalized = normalizeLookupValue(listName);
  return candidates.some((candidate) => normalizeLookupValue(candidate) === normalized);
}

function isMovedBeyondTodo(event, todoLists) {
  if (!event?.fromList || !event?.toList) {
    return false;
  }

  const fromIsTodo = isListMatch(event.fromList, todoLists);
  const toIsTodo = isListMatch(event.toList, todoLists);
  return fromIsTodo && !toIsTodo;
}

async function getTrackedWorkspaces(events = []) {
  const configuredRefs = splitCsv(config.summaryWorkspaceRefs);

  if (configuredRefs.length) {
    const workspaces = [];
    for (const ref of configuredRefs) {
      try {
        workspaces.push(await resolveWorkspace(ref));
      } catch (error) {
        console.warn(`Skipping summary workspace '${ref}':`, error.message);
      }
    }
    return uniqueBy(workspaces, (workspace) => workspace.id);
  }

  const workspaceResult = await listWorkspaces();
  const allWorkspaces = (Array.isArray(workspaceResult.data) ? workspaceResult.data : []).filter(
    (workspace) => !workspace.archived
  );

  if (allWorkspaces.length) {
    return allWorkspaces;
  }

  const fallback = events
    .map((event) => ({
      id: event.workspaceId,
      name: event.workspaceName,
      slug: event.workspaceSlug || "",
      archived: false
    }))
    .filter((workspace) => workspace.id && workspace.name);

  return uniqueBy(fallback, (workspace) => workspace.id);
}

async function loadCurrentInProgressTasks(workspace, inProgressLists) {
  const project = {
    name: workspace.name,
    company: config.blueDefaultCompany,
    workspaceId: workspace.id,
    listId: null,
    defaultAssignees: [],
    defaultTags: []
  };

  const result = await listRecords(project, { done: false });
  const tasks = Array.isArray(result.data) ? result.data : [];

  return tasks
    .filter((task) => isListMatch(task.list?.name, inProgressLists))
    .sort((left, right) => left.title.localeCompare(right.title));
}

function groupEventsByWorkspace(events) {
  const grouped = new Map();

  for (const event of events) {
    const workspaceId = event.workspaceId || "unknown";
    if (!grouped.has(workspaceId)) {
      grouped.set(workspaceId, []);
    }
    grouped.get(workspaceId).push(event);
  }

  return grouped;
}

function buildWorkspaceSection(workspace, { inProgressTasks, movedBeyondTodo }) {
  const lines = [`*Workspace: ${workspace.name}*`];
  const limitedInProgress = inProgressTasks.slice(0, 20);
  const limitedMoves = movedBeyondTodo.slice(0, 20);

  if (limitedInProgress.length) {
    lines.push("*In Progress*");
    limitedInProgress.forEach((task) => {
      lines.push(`- ${task.title} — ${formatAssigneeList(task.assignees)}`);
    });
    if (inProgressTasks.length > limitedInProgress.length) {
      lines.push(`- ...and ${inProgressTasks.length - limitedInProgress.length} more`);
    }
  } else {
    lines.push("*In Progress*");
    lines.push("- No tasks currently in progress.");
  }

  if (limitedMoves.length) {
    lines.push("*Moved Beyond To Do*");
    limitedMoves.forEach((event) => {
      lines.push(
        `- ${event.taskTitle || "Untitled task"}: ${event.fromList || "Unknown"} -> ${event.toList || "Unknown"}`
      );
    });
    if (movedBeyondTodo.length > limitedMoves.length) {
      lines.push(`- ...and ${movedBeyondTodo.length - limitedMoves.length} more`);
    }
  } else {
    lines.push("*Moved Beyond To Do*");
    lines.push("- No tasks moved beyond To do in the last 24 hours.");
  }

  return lines.join("\n");
}

export async function buildDailySummary() {
  const now = Date.now();
  const windowStart = now - config.summaryWindowHours * 60 * 60 * 1000;
  const cleanupBefore = now - config.summaryRetentionHours * 60 * 60 * 1000;
  const todoLists = splitCsv(config.summaryTodoLists);
  const inProgressLists = splitCsv(config.summaryInProgressLists);
  const storedEvents = isSummaryStoreConfigured()
    ? await getSummaryEventsBetween(windowStart, now)
    : [];

  const workspaces = await getTrackedWorkspaces(storedEvents);
  const eventsByWorkspace = groupEventsByWorkspace(storedEvents);
  const sections = [];

  for (const workspace of workspaces) {
    const workspaceEvents = (eventsByWorkspace.get(workspace.id) || [])
      .filter((event) => event.workspaceId === workspace.id)
      .sort((left, right) => Number(right.occurredAt || 0) - Number(left.occurredAt || 0));

    const movedBeyondTodo = uniqueBy(
      workspaceEvents.filter((event) => isMovedBeyondTodo(event, todoLists)),
      (event) => event.taskId || `${event.taskTitle}:${event.toList}:${event.occurredAt}`
    );
    const inProgressTasks = await loadCurrentInProgressTasks(workspace, inProgressLists);

    if (!inProgressTasks.length && !movedBeyondTodo.length) {
      continue;
    }

    sections.push(
      buildWorkspaceSection(workspace, {
        inProgressTasks,
        movedBeyondTodo
      })
    );
  }

  await cleanupSummaryEvents(cleanupBefore);

  if (!sections.length) {
    return {
      ok: true,
      text: "Daily Blue Summary\n\nNo in-progress work or moves beyond To do were found in the last 24 hours.",
      workspaceCount: 0,
      eventCount: storedEvents.length
    };
  }

  return {
    ok: true,
    text: ["Daily Blue Summary", ...sections].join("\n\n"),
    workspaceCount: sections.length,
    eventCount: storedEvents.length
  };
}
