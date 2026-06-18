import { spawn } from "node:child_process";
import process from "node:process";
import { config } from "./config.js";

function buildGlobalArgs(project) {
  const args = [];
  if (project?.company) {
    args.push("--company", project.company);
  }
  return args;
}

function normalizeResult(stdout, stderr, exitCode) {
  const trimmed = stdout.trim();
  let parsed = null;

  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = null;
    }
  }

  return {
    ok: exitCode === 0,
    exitCode,
    stdout: trimmed,
    stderr: stderr.trim(),
    data: parsed
  };
}

export function runBlue(args, { project, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.blueCliPath, [...buildGlobalArgs(project), ...args], {
      cwd: process.cwd(),
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `Failed to run Blue CLI at '${config.blueCliPath}'. Install it first or set BLUE_CLI_PATH. ${error.message}`
        )
      );
    });

    child.on("close", (exitCode) => {
      const result = normalizeResult(stdout, stderr, exitCode ?? 1);
      if (!result.ok) {
        reject(
          new Error(
            result.stderr || result.stdout || `Blue CLI command failed with exit code ${result.exitCode}.`
          )
        );
        return;
      }

      resolve(result);
    });

    if (stdin) {
      child.stdin.write(stdin);
    }

    child.stdin.end();
  });
}

export async function doctor(project) {
  return runBlue(["doctor", ...(project?.workspaceId ? ["--workspace", project.workspaceId] : [])], {
    project
  });
}

export async function listWorkspaces() {
  return runBlue(["ids", "workspace", "--format", "json"], {});
}

export async function listLists(workspaceRef, project) {
  return runBlue(["ids", "list", "--workspace", workspaceRef, "--format", "json"], { project });
}

export async function resolveWorkspace(workspaceRef) {
  const result = await listWorkspaces();
  const workspaces = Array.isArray(result.data) ? result.data : [];

  if (!workspaceRef) {
    throw new Error("Workspace is required when no configured project alias is provided.");
  }

  const normalized = workspaceRef.trim().toLowerCase();
  const exact = workspaces.find((workspace) => {
    const extra = String(workspace.extra || "");
    const slug = extra.startsWith("slug:") ? extra.slice(5) : extra;
    return (
      String(workspace.id).toLowerCase() === normalized ||
      String(workspace.name).toLowerCase() === normalized ||
      String(slug).toLowerCase() === normalized
    );
  });

  if (exact) {
    return exact;
  }

  const partialMatches = workspaces.filter((workspace) =>
    String(workspace.name).toLowerCase().includes(normalized)
  );

  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  if (partialMatches.length > 1) {
    throw new Error(
      `Workspace '${workspaceRef}' is ambiguous. Matches: ${partialMatches
        .map((workspace) => workspace.name)
        .join(", ")}`
    );
  }

  throw new Error(`Workspace '${workspaceRef}' was not found.`);
}

export async function resolveList(workspaceRef, listRef, project) {
  const result = await listLists(workspaceRef, project);
  const lists = Array.isArray(result.data) ? result.data : [];

  if (!listRef) {
    const preferred =
      lists.find((list) => String(list.name).toLowerCase() === "backlog") ||
      lists.find((list) => String(list.name).toLowerCase() === "to do") ||
      lists[0];

    if (!preferred) {
      throw new Error(`No lists found in workspace '${workspaceRef}'.`);
    }

    return preferred;
  }

  const normalized = listRef.trim().toLowerCase();
  const exact = lists.find(
    (list) =>
      String(list.id).toLowerCase() === normalized || String(list.name).toLowerCase() === normalized
  );

  if (exact) {
    return exact;
  }

  const partialMatches = lists.filter((list) => String(list.name).toLowerCase().includes(normalized));

  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  if (partialMatches.length > 1) {
    throw new Error(
      `List '${listRef}' is ambiguous in workspace '${workspaceRef}'. Matches: ${partialMatches
        .map((list) => list.name)
        .join(", ")}`
    );
  }

  throw new Error(`List '${listRef}' was not found in workspace '${workspaceRef}'.`);
}

export async function listRecords(project, filters = {}) {
  const args = ["records", "list", "--workspace", project.workspaceId, "--format", "json"];

  if (filters.done !== undefined) {
    args.push("--done", String(filters.done));
  }

  if (filters.assignee) {
    args.push("--assignee", filters.assignee);
  }

  return runBlue(args, { project });
}

export async function searchRecords(project, query, filters = {}) {
  const args = ["search", query, "--workspace", project.workspaceId, "--format", "json"];

  if (filters.done !== undefined) {
    args.push("--done", String(filters.done));
  }

  if (filters.limit) {
    args.push("--limit", String(filters.limit));
  }

  return runBlue(args, { project });
}

export async function createRecord(project, input) {
  const args = [
    "records",
    "create",
    "--workspace",
    project.workspaceId,
    "--list",
    input.listId || project.listId,
    "--title",
    input.title
  ];

  if (input.description) {
    args.push("--description", input.description);
  }

  if (input.assignees?.length) {
    args.push("--assignees", input.assignees.join(","));
  }

  if (input.tagIds?.length) {
    args.push("--tag-ids", input.tagIds.join(","));
  }

  if (input.customFields) {
    args.push("--custom-fields", input.customFields);
  }

  return runBlue(args, { project });
}

export async function updateRecord(project, input) {
  const args = [
    "records",
    "update",
    "--record",
    input.recordId,
    "--workspace",
    project.workspaceId
  ];

  if (input.title) {
    args.push("--title", input.title);
  }

  if (input.description) {
    args.push("--description", input.description);
  }

  if (input.assignees?.length) {
    args.push("--assignees", input.assignees.join(","));
  }

  if (input.tagIds?.length) {
    args.push("--tag-ids", input.tagIds.join(","));
  }

  if (input.customFields) {
    args.push("--custom-fields", input.customFields);
  }

  return runBlue(args, { project });
}

export async function moveRecord(project, input) {
  const args = [
    "records",
    "move",
    "--record",
    input.recordId,
    "--list",
    input.listId,
    "--workspace",
    project.workspaceId
  ];

  return runBlue(args, { project });
}

export async function createComment(project, input) {
  const args = [
    "comments",
    "create",
    "--record",
    input.recordId,
    "--workspace",
    project.workspaceId,
    "--text",
    input.text
  ];

  return runBlue(args, { project });
}
