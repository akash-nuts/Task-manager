import { config } from "./config.js";

const TODO_FIELDS = `
  id
  uid
  title
  text
  html
  done
  createdAt
  updatedAt
  startedAt
  duedAt
  todoList {
    id
    title
    project {
      id
      name
      slug
    }
  }
  users {
    id
    email
  }
  tags {
    id
    title
    color
  }
`;

function ensureBlueCredentials() {
  if (!config.blueClientId || !config.blueAuthToken || !config.blueCompanyId) {
    throw new Error(
      "Missing Blue API credentials. Set CLIENT_ID, AUTH_TOKEN, and COMPANY_ID in .env or your Vercel environment."
    );
  }
}

async function blueGraphql(query, variables = {}, options = {}) {
  ensureBlueCredentials();

  const headers = {
    "Content-Type": "application/json",
    "X-Bloo-Token-ID": config.blueClientId,
    "X-Bloo-Token-Secret": config.blueAuthToken,
    "X-Bloo-Company-ID": options.companyId || config.blueCompanyId
  };

  if (options.projectId) {
    headers["X-Bloo-Project-ID"] = options.projectId;
  }

  const response = await fetch(config.blueApiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error(
      `Blue API request failed with status ${response.status}${responseText ? `: ${responseText}` : ""}.`
    );
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  return payload.data;
}

function normalizeWorkspace(project) {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug || "",
    archived: Boolean(project.archived),
    extra: project.slug ? `slug:${project.slug}` : ""
  };
}

function normalizeLookupValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreTaskMatch(todo, queryText) {
  const rawQuery = String(queryText || "").trim().toLowerCase();
  const query = normalizeLookupValue(queryText);
  if (!rawQuery && !query) {
    return 0;
  }

  const title = String(todo?.title || "");
  const description = String(todo?.description || todo?.text || "");
  const normalizedTitle = normalizeLookupValue(title);
  const normalizedDescription = normalizeLookupValue(description);

  if (String(title).toLowerCase() === rawQuery) {
    return 1;
  }

  if (normalizedTitle === query) {
    return 0.98;
  }

  if (normalizedTitle.startsWith(query)) {
    return 0.94;
  }

  if (normalizedTitle.includes(query)) {
    return 0.9;
  }

  if (normalizedDescription.includes(query)) {
    return 0.72;
  }

  const queryTokens = query.split(" ").filter(Boolean);
  const titleTokens = normalizedTitle.split(" ").filter(Boolean);
  const descriptionTokens = normalizedDescription.split(" ").filter(Boolean);
  const tokenUniverse = new Set([...titleTokens, ...descriptionTokens]);
  const matchedTokens = queryTokens.filter((token) =>
    [...tokenUniverse].some((candidate) => candidate.includes(token) || token.includes(candidate))
  ).length;

  if (!matchedTokens) {
    return 0;
  }

  const titleTokenMatches = queryTokens.filter((token) =>
    titleTokens.some((candidate) => candidate.includes(token) || token.includes(candidate))
  ).length;

  return 0.45 + matchedTokens / Math.max(queryTokens.length, 1) * 0.25 + titleTokenMatches * 0.05;
}

function scoreWorkspaceMatch(workspace, workspaceRef) {
  const rawQuery = String(workspaceRef || "").trim().toLowerCase();
  const query = normalizeLookupValue(workspaceRef);
  if (!query && !rawQuery) {
    return 0;
  }

  const id = String(workspace.id || "").toLowerCase();
  const name = String(workspace.name || "").toLowerCase();
  const slug = String(workspace.slug || "").toLowerCase();
  const normalizedName = normalizeLookupValue(workspace.name);
  const normalizedSlug = normalizeLookupValue(workspace.slug);

  if (rawQuery === id) {
    return 1;
  }

  if (rawQuery === name || rawQuery === slug) {
    return 0.99;
  }

  if (query === normalizedName || query === normalizedSlug) {
    return 0.97;
  }

  if (normalizedName.startsWith(query) || normalizedSlug.startsWith(query)) {
    return 0.91;
  }

  if (normalizedName.includes(query) || normalizedSlug.includes(query)) {
    return 0.84;
  }

  const queryTokens = query.split(" ").filter(Boolean);
  const nameTokens = normalizedName.split(" ").filter(Boolean);
  const slugTokens = normalizedSlug.split(" ").filter(Boolean);
  const tokenUniverse = new Set([...nameTokens, ...slugTokens]);
  const matchedTokens = queryTokens.filter((token) =>
    [...tokenUniverse].some((candidate) => candidate.includes(token) || token.includes(candidate))
  ).length;

  if (matchedTokens > 0) {
    return 0.55 + matchedTokens / Math.max(queryTokens.length, 1) * 0.25;
  }

  return 0;
}

function normalizeList(list) {
  return {
    id: list.id,
    name: list.title,
    title: list.title,
    position: list.position,
    completed: Boolean(list.completed),
    todosCount: list.todosCount ?? null
  };
}

function normalizeTodo(todo) {
  if (!todo) {
    return null;
  }

  return {
    id: todo.id,
    uid: todo.uid,
    title: todo.title,
    description: todo.text || "",
    text: todo.text || "",
    html: todo.html || "",
    done: Boolean(todo.done),
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
    startedAt: todo.startedAt,
    duedAt: todo.duedAt,
    list: todo.todoList
      ? {
          id: todo.todoList.id,
          name: todo.todoList.title,
          workspaceId: todo.todoList.project?.id || null,
          workspace: todo.todoList.project?.name || null,
          workspaceSlug: todo.todoList.project?.slug || null
        }
      : null,
    assignees: Array.isArray(todo.users)
      ? todo.users.map((user) => ({
          id: user.id,
          email: user.email || ""
        }))
      : [],
    tags: Array.isArray(todo.tags)
      ? todo.tags.map((tag) => ({
          id: tag.id,
          title: tag.title,
          color: tag.color || ""
        }))
      : []
  };
}

function normalizeUser(user) {
  return {
    id: user.id,
    email: user.email || "",
    username: user.username || "",
    fullName: user.fullName || "",
    firstName: user.firstName || "",
    lastName: user.lastName || ""
  };
}

function parseCustomFields(customFields) {
  if (!customFields) {
    return [];
  }

  if (Array.isArray(customFields)) {
    return customFields;
  }

  if (typeof customFields === "string") {
    const parsed = JSON.parse(customFields);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  return [customFields];
}

function toCreateTagInputs(tagIds = []) {
  return tagIds.map((id) => ({ id }));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function setTodoAssignees(todoId, assigneeIds) {
  if (!assigneeIds) {
    return null;
  }

  const mutation = `
    mutation SetTodoAssignees($input: SetTodoAssigneesInput!) {
      setTodoAssignees(input: $input) {
        success
      }
    }
  `;

  await blueGraphql(
    mutation,
    {
      input: {
        todoId,
        assigneeIds
      }
    },
    { projectId: null }
  );
  return null;
}

async function setTodoTags(todoId, tagIds) {
  if (!tagIds) {
    return null;
  }

  const mutation = `
    mutation SetTodoTags($input: SetTodoTagsInput!) {
      setTodoTags(input: $input) {
        ${TODO_FIELDS}
      }
    }
  `;

  const data = await blueGraphql(mutation, {
    input: {
      todoId,
      tagIds
    }
  });

  return normalizeTodo(data.setTodoTags);
}

async function setTodoCustomFields(todoId, customFields) {
  const parsedFields = parseCustomFields(customFields);
  if (!parsedFields.length) {
    return [];
  }

  const mutation = `
    mutation SetTodoCustomField($input: SetTodoCustomFieldInput!) {
      setTodoCustomField(input: $input) {
        id
      }
    }
  `;

  const results = [];
  for (const field of parsedFields) {
    const data = await blueGraphql(mutation, {
      input: {
        todoId,
        ...field
      }
    });
    results.push(data.setTodoCustomField);
  }

  return results;
}

export async function listWorkspaces() {
  const query = `
    query ListWorkspaces($companyId: String!) {
      projectList(filter: { companyIds: [$companyId] }, first: 1000) {
        items {
          id
          name
          slug
          archived
        }
      }
    }
  `;

  const data = await blueGraphql(query, { companyId: config.blueCompanyId });
  return {
    data: (data.projectList?.items || []).map(normalizeWorkspace)
  };
}

export async function findWorkspaceMatches(workspaceRef, { limit = 5, includeArchived = true } = {}) {
  const result = await listWorkspaces();
  const workspaces = (Array.isArray(result.data) ? result.data : []).filter(
    (workspace) => includeArchived || !workspace.archived
  );

  if (!String(workspaceRef || "").trim()) {
    return workspaces
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, limit)
      .map((workspace) => ({
        ...workspace,
        score: 0
      }));
  }

  const scored = workspaces
    .map((workspace) => ({
      ...workspace,
      score: scoreWorkspaceMatch(workspace, workspaceRef)
    }))
    .filter((workspace) => workspace.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

  return scored.slice(0, limit);
}

export async function listLists(workspaceRef) {
  const query = `
    query ListLists($projectId: String!) {
      todoLists(projectId: $projectId) {
        id
        title
        position
        completed
        todosCount
      }
    }
  `;

  const data = await blueGraphql(query, { projectId: workspaceRef }, { projectId: workspaceRef });
  return {
    data: (data.todoLists || []).map(normalizeList)
  };
}

export async function listWorkspaceUsers(workspaceRef) {
  const query = `
    query ListWorkspaceUsers($projectId: String!, $first: Int) {
      projectUserList(projectId: $projectId, first: $first) {
        users {
          id
          email
          username
          fullName
          firstName
          lastName
        }
        totalCount
      }
    }
  `;

  const data = await blueGraphql(query, { projectId: workspaceRef, first: 200 }, { projectId: workspaceRef });
  return {
    data: (data.projectUserList?.users || []).map(normalizeUser)
  };
}

export async function resolveAssignees(workspaceRef, assigneeRefs) {
  const refs = (assigneeRefs || []).map((value) => String(value || "").trim()).filter(Boolean);
  if (!refs.length) {
    throw new Error("At least one assignee is required.");
  }

  const result = await listWorkspaceUsers(workspaceRef);
  const users = Array.isArray(result.data) ? result.data : [];
  if (!users.length) {
    throw new Error("No workspace members were found to assign this task to.");
  }

  const resolved = [];
  for (const ref of refs) {
    const normalized = normalizeLookupValue(ref);
    const exact = users.find((user) => {
      return (
        String(user.id).toLowerCase() === ref.toLowerCase() ||
        String(user.email).toLowerCase() === ref.toLowerCase() ||
        String(user.username).toLowerCase() === ref.toLowerCase() ||
        normalizeLookupValue(user.fullName) === normalized ||
        normalizeLookupValue(`${user.firstName} ${user.lastName}`) === normalized
      );
    });

    if (exact) {
      resolved.push(exact);
      continue;
    }

    const partialMatches = users.filter((user) => {
      return (
        normalizeLookupValue(user.fullName).includes(normalized) ||
        normalizeLookupValue(`${user.firstName} ${user.lastName}`).includes(normalized) ||
        String(user.username).toLowerCase().includes(ref.toLowerCase()) ||
        String(user.email).toLowerCase().includes(ref.toLowerCase())
      );
    });

    if (partialMatches.length === 1) {
      resolved.push(partialMatches[0]);
      continue;
    }

    if (partialMatches.length > 1) {
      throw new Error(
        `Assignee '${ref}' is ambiguous. Matches: ${partialMatches
          .map((user) => user.fullName || user.username || user.email || user.id)
          .join(", ")}`
      );
    }

    throw new Error(
      `Assignee '${ref}' was not found in this workspace. Available users include: ${users
        .slice(0, 5)
        .map((user) => user.fullName || user.username || user.email || user.id)
        .join(", ")}`
    );
  }

  const unique = [];
  for (const user of resolved) {
    if (!unique.find((item) => item.id === user.id)) {
      unique.push(user);
    }
  }

  return unique;
}

export async function resolveWorkspace(workspaceRef) {
  const result = await listWorkspaces();
  const workspaces = Array.isArray(result.data) ? result.data : [];

  if (!workspaceRef) {
    throw new Error("Workspace is required when no configured project alias is provided.");
  }

  const normalized = workspaceRef.trim().toLowerCase();
  const exact = workspaces.find((workspace) => {
    const slug = workspace.slug || "";
    const normalizedQuery = normalizeLookupValue(workspaceRef);
    return (
      String(workspace.id).toLowerCase() === normalized ||
      String(workspace.name).toLowerCase() === normalized ||
      String(slug).toLowerCase() === normalized ||
      normalizeLookupValue(workspace.name) === normalizedQuery ||
      normalizeLookupValue(slug) === normalizedQuery
    );
  });

  if (exact) {
    return exact;
  }

  const partialMatches = workspaces.filter((workspace) =>
    String(workspace.name).toLowerCase().includes(normalized) ||
    normalizeLookupValue(workspace.name).includes(normalizeLookupValue(workspaceRef)) ||
    normalizeLookupValue(workspace.slug).includes(normalizeLookupValue(workspaceRef))
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

export async function resolveList(workspaceRef, listRef) {
  const result = await listLists(workspaceRef);
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
  const query = `
    query ListRecords($projectId: String!, $done: Boolean, $assigneeIds: [String!], $first: Int) {
      todoLists(projectId: $projectId) {
        id
        title
        todos(done: $done, assigneeIds: $assigneeIds, first: $first, orderBy: position_ASC) {
          ${TODO_FIELDS}
        }
      }
    }
  `;

  const data = await blueGraphql(
    query,
    {
      projectId: project.workspaceId,
      done: filters.done ?? null,
      assigneeIds: filters.assignee ? [filters.assignee] : null,
      first: 100
    },
    { projectId: project.workspaceId }
  );

  const records = [];
  for (const list of data.todoLists || []) {
    for (const todo of list.todos || []) {
      records.push(normalizeTodo(todo));
    }
  }

  return { data: records };
}

export async function searchRecords(project, queryText, filters = {}) {
  try {
    const query = `
      query SearchRecords($query: String!, $companyId: String!) {
        search(query: $query, companyId: $companyId) {
          totalCount
          hits {
            _id
            _source {
              __typename
              ... on Todo {
                ${TODO_FIELDS}
              }
            }
          }
        }
      }
    `;

    const data = await blueGraphql(query, {
      query: queryText,
      companyId: config.blueCompanyId
    });

    const apiResults = (data.search?.hits || [])
      .map((hit) => hit?._source)
      .filter((source) => source?.__typename === "Todo")
      .map(normalizeTodo)
      .filter((todo) => todo?.list?.workspaceId === project.workspaceId)
      .filter((todo) => (filters.done === undefined ? true : todo.done === filters.done))
      .filter((todo) =>
        !filters.assignee ? true : todo.assignees.some((assignee) => assignee.id === filters.assignee)
      );

    if (apiResults.length > 0) {
      return {
        data: filters.limit ? apiResults.slice(0, filters.limit) : apiResults
      };
    }
  } catch (_error) {
    // Blue's global search can return 400s for some workspaces/accounts. We fall back to
    // scanning the workspace task list directly so Slack search still works reliably.
  }

  const listResult = await listRecords(project, {
    done: filters.done,
    assignee: filters.assignee
  });

  const fallbackResults = (Array.isArray(listResult.data) ? listResult.data : [])
    .map((todo) => ({
      todo,
      score: scoreTaskMatch(todo, queryText)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.todo.title.localeCompare(right.todo.title))
    .map((entry) => entry.todo);

  return {
    data: filters.limit ? fallbackResults.slice(0, filters.limit) : fallbackResults
  };
}

export async function getRecord(recordId, options = {}) {
  const query = `
    query GetRecord($id: String!) {
      todo(id: $id) {
        ${TODO_FIELDS}
      }
    }
  `;

  const data = await blueGraphql(
    query,
    { id: recordId },
    options.projectId ? { projectId: options.projectId } : {}
  );
  const todo = normalizeTodo(data.todo);

  if (!todo) {
    throw new Error(`Task '${recordId}' was not found in Blue.`);
  }

  return { data: todo };
}

export async function createRecord(project, input) {
  const mutation = `
    mutation CreateRecord($input: CreateTodoInput!) {
      createTodo(input: $input) {
        ${TODO_FIELDS}
      }
    }
  `;

  const data = await blueGraphql(
    mutation,
    {
      input: {
        todoListId: input.listId || project.listId,
        title: input.title,
        description: input.description || undefined,
        assigneeIds: input.assignees?.length ? input.assignees : undefined,
        tags: input.tagIds?.length ? toCreateTagInputs(input.tagIds) : undefined,
        customFields: input.customFields ? parseCustomFields(input.customFields) : undefined
      }
    },
    { projectId: project.workspaceId }
  );

  return {
    data: normalizeTodo(data.createTodo)
  };
}

export async function updateRecord(project, input) {
  const mutation = `
    mutation EditRecord($input: EditTodoInput!) {
      editTodo(input: $input) {
        ${TODO_FIELDS}
      }
    }
  `;

  const data = await blueGraphql(
    mutation,
    {
      input: {
        todoId: input.recordId,
        title: input.title || undefined,
        text: input.description || undefined,
        html: input.description ? `<p>${escapeHtml(input.description).replaceAll("\n", "<br>")}</p>` : undefined
      }
    },
    { projectId: project.workspaceId }
  );

  let todo = normalizeTodo(data.editTodo);

  if (input.assignees) {
    await setTodoAssignees(input.recordId, input.assignees);
    todo = (await getRecord(input.recordId, { projectId: project.workspaceId })).data || todo;
  }

  if (input.tagIds) {
    todo = (await setTodoTags(input.recordId, input.tagIds)) || todo;
  }

  if (input.customFields) {
    await setTodoCustomFields(input.recordId, input.customFields);
  }

  return { data: todo };
}

export async function moveRecord(project, input) {
  const mutation = `
    mutation MoveRecord($input: MoveTodoInput!) {
      moveTodo(input: $input)
    }
  `;

  await blueGraphql(
    mutation,
    {
      input: {
        todoId: input.recordId,
        todoListId: input.listId
      }
    },
    { projectId: project.workspaceId }
  );

  return {
    data: (await getRecord(input.recordId, { projectId: project.workspaceId })).data
  };
}

export async function createComment(project, input) {
  const mutation = `
    mutation CreateComment($input: CreateCommentInput!) {
      createComment(input: $input) {
        id
        text
        createdAt
      }
    }
  `;

  const safeText = String(input.text || "").trim();
  const data = await blueGraphql(
    mutation,
    {
      input: {
        text: safeText,
        html: `<p>${escapeHtml(safeText)}</p>`,
        category: "TODO",
        categoryId: input.recordId
      }
    },
    { projectId: project.workspaceId }
  );

  return {
    data: data.createComment
  };
}
