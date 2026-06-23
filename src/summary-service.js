import { config } from "./config.js";
import { listRecords, listWorkspaces, resolveWorkspace } from "./blue-api.js";
import { cleanupSummaryEvents, getSummaryEventsBetween, isSummaryStoreConfigured } from "./summary-store.js";

function normalizeLookupValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compactLookupValue(value) {
  return normalizeLookupValue(value).replace(/\s+/g, "");
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
  const compact = compactLookupValue(listName);
  return candidates.some((candidate) => {
    const normalizedCandidate = normalizeLookupValue(candidate);
    return normalizedCandidate === normalized || compactLookupValue(candidate) === compact;
  });
}

function classifyListStage(listName, { todoLists, inProgressLists, doneLists }) {
  if (isListMatch(listName, todoLists)) {
    return "todo";
  }

  if (isListMatch(listName, inProgressLists)) {
    return "in_progress";
  }

  if (isListMatch(listName, doneLists)) {
    return "done";
  }

  return "other";
}

function isMovedBeyondTodo(event, listGroups) {
  if (!event?.fromList || !event?.toList) {
    return false;
  }

  const fromStage = classifyListStage(event.fromList, listGroups);
  const toStage = classifyListStage(event.toList, listGroups);
  return fromStage === "todo" && toStage !== "todo";
}

async function getTrackedWorkspaces(events = []) {
  const configuredRefs = splitCsv(config.summaryWorkspaceRefs);

  if (configuredRefs.length) {
    const workspaces = [];
    const skipped = [];
    for (const ref of configuredRefs) {
      try {
        workspaces.push(await resolveWorkspace(ref));
      } catch (error) {
        console.warn(`Skipping summary workspace '${ref}':`, error.message);
        skipped.push({
          ref,
          error: error.message
        });
      }
    }
    return {
      workspaces: uniqueBy(workspaces, (workspace) => workspace.id),
      debug: {
        mode: "configured",
        configuredRefs,
        resolvedRefs: workspaces.map((workspace) => ({
          ref: workspace.slug || workspace.name || workspace.id,
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug || ""
        })),
        skippedRefs: skipped
      }
    };
  }

  const workspaceResult = await listWorkspaces();
  const allWorkspaces = (Array.isArray(workspaceResult.data) ? workspaceResult.data : []).filter(
    (workspace) => !workspace.archived
  );

  if (allWorkspaces.length) {
    return {
      workspaces: allWorkspaces,
      debug: {
        mode: "all_accessible",
        configuredRefs: [],
        resolvedRefs: allWorkspaces.map((workspace) => ({
          ref: workspace.slug || workspace.name || workspace.id,
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug || ""
        })),
        skippedRefs: []
      }
    };
  }

  const fallback = events
    .map((event) => ({
      id: event.workspaceId,
      name: event.workspaceName,
      slug: event.workspaceSlug || "",
      archived: false
    }))
    .filter((workspace) => workspace.id && workspace.name);

  return {
    workspaces: uniqueBy(fallback, (workspace) => workspace.id),
    debug: {
      mode: "events_fallback",
      configuredRefs: [],
      resolvedRefs: fallback.map((workspace) => ({
        ref: workspace.slug || workspace.name || workspace.id,
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug || ""
      })),
      skippedRefs: []
    }
  };
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
  const openListNames = uniqueBy(
    tasks
      .map((task) => task.list?.name)
      .filter(Boolean)
      .map((name) => ({ name })),
    (item) => normalizeLookupValue(item.name)
  ).map((item) => item.name);

  const inProgressTasks = tasks
    .filter((task) => isListMatch(task.list?.name, inProgressLists))
    .sort((left, right) => left.title.localeCompare(right.title));

  return {
    tasks: inProgressTasks,
    debug: {
      openTaskCount: tasks.length,
      openListNames,
      inProgressTaskCount: inProgressTasks.length
    }
  };
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

export async function buildDailySummary(options = {}) {
  const debugEnabled = Boolean(options.debug);
  const now = Date.now();
  const windowStart = now - config.summaryWindowHours * 60 * 60 * 1000;
  const cleanupBefore = now - config.summaryRetentionHours * 60 * 60 * 1000;
  const todoLists = splitCsv(config.summaryTodoLists);
  const inProgressLists = splitCsv(config.summaryInProgressLists);
  const doneLists = splitCsv(config.summaryDoneLists);
  const listGroups = {
    todoLists,
    inProgressLists,
    doneLists
  };
  const storedEvents = isSummaryStoreConfigured()
    ? await getSummaryEventsBetween(windowStart, now)
    : [];

  const tracked = await getTrackedWorkspaces(storedEvents);
  const workspaces = tracked.workspaces;
  const eventsByWorkspace = groupEventsByWorkspace(storedEvents);
  const sections = [];
  const debug = {
    enabled: debugEnabled,
    config: {
      summaryWorkspaceRefs: config.summaryWorkspaceRefs,
      inProgressLists,
      doneLists,
      todoLists
    },
    workspaceResolution: tracked.debug,
    workspaces: []
  };

  for (const workspace of workspaces) {
    const workspaceEvents = (eventsByWorkspace.get(workspace.id) || [])
      .filter((event) => event.workspaceId === workspace.id)
      .sort((left, right) => Number(right.occurredAt || 0) - Number(left.occurredAt || 0));

    const movedBeyondTodo = uniqueBy(
      workspaceEvents.filter((event) => isMovedBeyondTodo(event, listGroups)),
      (event) => event.taskId || `${event.taskTitle}:${event.toList}:${event.occurredAt}`
    );
    const inProgressResult = await loadCurrentInProgressTasks(workspace, inProgressLists);
    const inProgressTasks = inProgressResult.tasks;

    if (debugEnabled) {
      debug.workspaces.push({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug || "",
        inProgressTaskCount: inProgressResult.debug.inProgressTaskCount,
        openTaskCount: inProgressResult.debug.openTaskCount,
        openListNames: inProgressResult.debug.openListNames,
        movedBeyondTodoCount: movedBeyondTodo.length,
        includedInSummary: Boolean(inProgressTasks.length || movedBeyondTodo.length)
      });
    }

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
      eventCount: storedEvents.length,
      ...(debugEnabled ? { debug } : {})
    };
  }

  return {
    ok: true,
    text: ["Daily Blue Summary", ...sections].join("\n\n"),
    workspaceCount: sections.length,
    eventCount: storedEvents.length,
    ...(debugEnabled ? { debug } : {})
  };
}
