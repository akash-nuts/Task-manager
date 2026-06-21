import crypto from "node:crypto";
import express from "express";
import { waitUntil } from "@vercel/functions";
import { config } from "./config.js";
import { findWorkspaceMatches, searchRecords } from "./blue-api.js";
import { dispatchHumanCommand, dispatchParsedCommand, parseHumanCommand } from "./task-router.js";

const app = express();

function runInBackground(promise) {
  try {
    waitUntil(
      Promise.resolve(promise).catch((error) => {
        console.error("Background Slack task failed:", error);
      })
    );
  } catch {
    void Promise.resolve(promise).catch((error) => {
      console.error("Background Slack task failed:", error);
    });
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/routes", (_req, res) => {
  res.json({
    ok: true,
    routes: {
      slackEvents: "/slack/events",
      slackCommands: "/slack/commands",
      slackInteractions: "/slack/interactions",
      emailInbound: "/email/inbound"
    }
  });
});

function verifySlackSignature(req) {
  if (!config.slackSigningSecret) {
    throw new Error("Missing SLACK_SIGNING_SECRET.");
  }

  const timestamp = req.header("x-slack-request-timestamp");
  const signature = req.header("x-slack-signature");

  if (!timestamp || !signature) {
    return false;
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (Number.isFinite(ageSeconds) && ageSeconds > 60 * 5) {
    return false;
  }

  const body = req.body.toString("utf8");
  const baseString = `v0:${timestamp}:${body}`;
  const computed =
    "v0=" +
    crypto.createHmac("sha256", config.slackSigningSecret).update(baseString).digest("hex");

  if (computed.length !== signature.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed));
}

function normalizeLookupValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function formatAssignees(assignees = []) {
  if (!Array.isArray(assignees) || !assignees.length) {
    return "";
  }

  return assignees
    .map((assignee) => assignee.email || assignee.id)
    .filter(Boolean)
    .join(", ");
}

function buildBlueTaskUrl(task) {
  if (!task) {
    return null;
  }

  if (!config.blueTaskUrlTemplate) {
    if (!task.list?.workspaceSlug || !task.id) {
      return null;
    }

    return `${config.blueWebBaseUrl}/org/${config.blueCompanyId}/workspace/${task.list.workspaceSlug}/records/board/${task.id}`;
  }

  return config.blueTaskUrlTemplate
    .replaceAll("{baseUrl}", config.blueWebBaseUrl)
    .replaceAll("{companyId}", config.blueCompanyId)
    .replaceAll("{workspaceSlug}", task.list?.workspaceSlug || "")
    .replaceAll("{workspaceId}", task.list?.workspaceId || "")
    .replaceAll("{taskUid}", task.uid || "")
    .replaceAll("{taskId}", task.id || "");
}

function toSlackJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function fromSlackJson(value) {
  return JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
}

function isPublicSuccessAction(action) {
  return ["create", "bulk_create", "update", "move", "comment"].includes(action);
}

function taskSummaryLine(task, index) {
  const link = buildBlueTaskUrl(task);
  const assignees = formatAssignees(task.assignees);

  return `${index + 1}. ${task.title} | Status: ${task.list?.name || "Unknown"}${
    assignees ? ` | Assignee: ${assignees}` : ""
  }${link ? ` | Link: ${link}` : ""}`;
}

function slackResultText(result) {
  const workspace = result.workspace || result.project || "Blue";
  const list = result.list ? ` in ${result.list}` : "";

  if (result.action === "help") {
    return String(result.result || "");
  }

  if (result.action === "bulk_create") {
    const items = result.result?.created || [];
    const lines = [`Created ${result.result.createdCount} tasks successfully in ${workspace}${list}.`];
    items.forEach((task, index) => lines.push(taskSummaryLine(task, index)));
    return lines.join("\n");
  }

  if (["create", "update", "move"].includes(result.action) && result.result?.title) {
    const link = buildBlueTaskUrl(result.result);
    const assignees = formatAssignees(result.result.assignees);
    const actionLabel =
      result.action === "create"
        ? "Created"
        : result.action === "update"
          ? "Updated"
          : "Moved";

    return [
      `${actionLabel} task "${result.result.title}" successfully in ${workspace}${result.result.list?.name ? ` (${result.result.list.name})` : list}.`,
      assignees ? `Assignee: ${assignees}.` : null,
      result.result.description ? `Description: ${result.result.description}` : null,
      link ? `Link: ${link}` : null
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.action === "comment" && result.result?.title) {
    const link = buildBlueTaskUrl(result.result);
    return [
      `Added a comment to "${result.result.title}" in ${workspace}.`,
      link ? `Link: ${link}` : null
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.action === "status" && result.result?.title) {
    const task = result.result;
    const link = buildBlueTaskUrl(task);
    const assignees = formatAssignees(task.assignees);
    return [
      `"${task.title}" is currently in ${task.list?.name || "Unknown"} in ${workspace}.`,
      assignees ? `Assignee: ${assignees}.` : null,
      task.done ? "Status: Done." : "Status: Open.",
      link ? `Link: ${link}` : null
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (["search", "list"].includes(result.action) && Array.isArray(result.result)) {
    if (!result.result.length) {
      return result.action === "search"
        ? `No matching tasks found in ${workspace}.`
        : `No tasks found in ${workspace}${list}.`;
    }

    const header =
      result.action === "search"
        ? `Top matching tasks in ${workspace} for "${result.query}"${
            result.assignee ? ` assigned to ${result.assignee}` : ""
          }:`
        : `Tasks in ${workspace}${list}${result.assignee ? ` assigned to ${result.assignee}` : ""}:`;
    return [header, ...result.result.map((task, index) => taskSummaryLine(task, index))].join("\n");
  }

  if (!result?.result || typeof result.result === "string") {
    return `Completed in ${workspace}${list}.\n${result.result || ""}`.trim();
  }

  return `Completed in ${workspace}${list}.\n${JSON.stringify(result.result, null, 2)}`;
}

function buildWorkspaceSelectionResponse(command, candidates, { noGoodMatch = false } = {}) {
  const subject =
    command.action === "create"
      ? `create "${command.payload.title}"`
      : command.action === "bulk_create"
        ? `create ${command.payload.titles.length} tasks`
        : command.action === "search"
          ? `search for "${command.payload.query}"`
          : command.action === "list"
            ? "list tasks"
            : command.action === "status"
              ? `find "${command.payload.taskQuery}"`
              : command.action === "update"
                ? `update "${command.payload.taskQuery}"`
                : command.action === "move"
                  ? `move "${command.payload.taskQuery}"`
                  : command.action === "comment"
                    ? `comment on "${command.payload.taskQuery}"`
                    : "continue";
  const intro = noGoodMatch
    ? `I couldn't find an exact Blue workspace for "${command.payload.workspace}". Which workspace should I use to ${subject}?`
    : `I found a few possible workspaces for "${command.payload.workspace}". Which one should I use to ${subject}?`;

  return {
    response_type: "ephemeral",
    text: intro,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: intro
        }
      },
      {
        type: "actions",
        elements: [
          ...candidates.slice(0, 5).map((workspace) => ({
            type: "button",
            text: {
              type: "plain_text",
              text: workspace.archived ? `${workspace.name} (archived)` : workspace.name
            },
            action_id: "blue_select_workspace",
            value: toSlackJson({
              action: command.action,
              payload: {
                ...command.payload,
                workspace: workspace.name
              }
            })
          })),
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Cancel"
            },
            style: "danger",
            action_id: "blue_cancel_workspace_selection",
            value: "cancel"
          }
        ]
      }
    ]
  };
}

function buildTaskSelectionResponse(command, tasks) {
  const workspace = command.payload.workspace;
  const intro = `I found a few matching tasks in ${workspace}. Which one should I use?`;

  return {
    response_type: "ephemeral",
    text: intro,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: intro
        }
      },
      {
        type: "actions",
        elements: tasks.slice(0, 5).map((task) => ({
          type: "button",
          text: {
            type: "plain_text",
            text: `${task.title.slice(0, 50)}${task.title.length > 50 ? "..." : ""}`
          },
          action_id: "blue_select_task",
          value: toSlackJson({
            action: command.action,
            payload: {
              ...command.payload,
              recordId: task.id
            }
          })
        }))
      },
      {
        type: "context",
        elements: tasks.slice(0, 5).map((task, index) => ({
          type: "mrkdwn",
          text: `${index + 1}. ${task.title} | ${task.list?.name || "Unknown"}`
        }))
      }
    ]
  };
}

async function postSlackApi(method, payload) {
  if (!config.slackBotToken) {
    return null;
  }

  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slackBotToken}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack ${method} failed: ${data.error || "unknown_error"}`);
  }

  return data;
}

async function postSlackMessage(channel, text, threadTs) {
  return postSlackApi("chat.postMessage", {
    channel,
    text,
    thread_ts: threadTs || undefined
  });
}

async function postSlackEphemeral(channel, user, text, blocks) {
  return postSlackApi("chat.postEphemeral", {
    channel,
    user,
    text,
    blocks: blocks || undefined
  });
}

function createTaskSearchQuery(command) {
  if (command.action === "status") {
    return command.payload.taskQuery;
  }

  if (command.action === "update" || command.action === "move" || command.action === "comment") {
    return command.payload.taskQuery;
  }

  return "";
}

async function maybeResolveWorkspace(command) {
  const workspaceRef = command.payload?.workspace;
  const workspaceActions = ["create", "bulk_create", "search", "list", "status", "update", "move", "comment"];

  if (!workspaceActions.includes(command.action) || !workspaceRef) {
    return null;
  }

  const candidates = await findWorkspaceMatches(workspaceRef, {
    limit: 5,
    includeArchived: true
  });

  if (!candidates.length) {
    const allWorkspaces = await findWorkspaceMatches("", { limit: 5, includeArchived: true });
    return {
      type: "selection",
      payload: buildWorkspaceSelectionResponse(command, allWorkspaces, { noGoodMatch: true })
    };
  }

  const [best, second] = candidates;
  const strongMatch = best.score >= 0.9;
  const clearWinner = !second || best.score - second.score >= 0.08;

  if (!(strongMatch && clearWinner)) {
    return {
      type: "selection",
      payload: buildWorkspaceSelectionResponse(command, candidates, { noGoodMatch: best.score < 0.9 })
    };
  }

  command.payload.workspace = best.name;
  command.payload.workspaceId = best.id;
  return null;
}

async function maybeResolveTask(command) {
  const taskLookupActions = ["status", "update", "move", "comment"];
  if (!taskLookupActions.includes(command.action)) {
    return null;
  }

  if (command.payload.recordId || !command.payload.taskQuery || !command.payload.workspace) {
    return null;
  }

  const project = {
    name: command.payload.workspace,
    workspaceId: command.payload.workspaceId,
    defaultTags: [],
    defaultAssignees: []
  };
  const tasks = (await searchRecords(project, createTaskSearchQuery(command), { limit: 5 })).data || [];

  if (!tasks.length) {
    throw new Error(
      `I couldn't find any matching task in ${command.payload.workspace} for "${command.payload.taskQuery}".`
    );
  }

  const normalizedQuery = normalizeLookupValue(command.payload.taskQuery);
  const exact = tasks.find((task) => normalizeLookupValue(task.title) === normalizedQuery);
  if (exact) {
    command.payload.recordId = exact.id;
    return null;
  }

  if (tasks.length === 1) {
    command.payload.recordId = tasks[0].id;
    return null;
  }

  return {
    type: "selection",
    payload: buildTaskSelectionResponse(command, tasks)
  };
}

function slackPayloadForResult(result) {
  const responseType = isPublicSuccessAction(result.action) ? "in_channel" : "ephemeral";
  return {
    response_type: responseType,
    text: slackResultText(result)
  };
}

async function prepareSlackCommandResponse({ text, fallbackWorkspace }) {
  const command = parseHumanCommand(text, fallbackWorkspace);

  const workspaceResolution = await maybeResolveWorkspace(command);
  if (workspaceResolution) {
    return workspaceResolution;
  }

  const taskResolution = await maybeResolveTask(command);
  if (taskResolution) {
    return taskResolution;
  }

  const result = await dispatchParsedCommand(command);
  return {
    type: "result",
    payload: slackPayloadForResult(result)
  };
}

async function processSlackCommand({ text, fallbackWorkspace, channel, threadTs, responseUrl, userId }) {
  try {
    const outcome = await prepareSlackCommandResponse({ text, fallbackWorkspace });

    if (responseUrl) {
      await fetch(responseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(outcome.payload)
      });
      return { ok: true };
    }

    if (!channel) {
      return { ok: true };
    }

    if (outcome.payload.response_type === "ephemeral") {
      await postSlackEphemeral(channel, userId, outcome.payload.text, outcome.payload.blocks);
    } else {
      await postSlackMessage(channel, outcome.payload.text, threadTs);
    }

    return { ok: true };
  } catch (error) {
    const message = `Blue command failed: ${error.message}`;

    if (responseUrl) {
      await fetch(responseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          response_type: "ephemeral",
          text: message
        })
      });
    } else if (channel && userId) {
      await postSlackEphemeral(channel, userId, message);
    }

    return { ok: false, error: error.message };
  }
}

app.use("/email/inbound", express.json());
app.use("/email/inbound", express.urlencoded({ extended: true }));

app.post("/email/inbound", async (req, res) => {
  try {
    const providedSecret = req.header("x-email-shared-secret");
    if (!config.emailSharedSecret || providedSecret !== config.emailSharedSecret) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const commandText =
      req.body?.text ||
      req.body?.subject ||
      req.body?.["stripped-text"] ||
      req.body?.body_plain ||
      req.body?.plain ||
      "";
    const workspace = req.body?.workspace || req.body?.project || config.emailDefaultProject;
    const result = await dispatchHumanCommand(commandText, workspace);

    return res.json({ ok: true, result });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.use("/slack/events", express.raw({ type: "application/json" }));
app.use("/slack/commands", express.raw({ type: "application/x-www-form-urlencoded" }));
app.use("/slack/interactions", express.raw({ type: "application/x-www-form-urlencoded" }));

app.post("/slack/events", async (req, res) => {
  try {
    if (!verifySlackSignature(req)) {
      return res.status(401).json({ ok: false, error: "Invalid Slack signature" });
    }

    const payload = JSON.parse(req.body.toString("utf8"));

    if (payload.type === "url_verification") {
      return res.json({ challenge: payload.challenge });
    }

    if (payload.type !== "event_callback") {
      return res.json({ ok: true, ignored: true });
    }

    const event = payload.event || {};
    if (
      (event.type !== "app_mention" && event.type !== "message") ||
      event.subtype === "bot_message" ||
      !event.text
    ) {
      return res.json({ ok: true, ignored: true });
    }

    const text = String(event.text || "").replace(/<@[^>]+>/g, "").trim();
    const workspace = config.slackDefaultProject;

    res.json({ ok: true });

    runInBackground(processSlackCommand({
      text,
      fallbackWorkspace: workspace,
      channel: event.channel,
      threadTs: event.thread_ts || event.ts,
      userId: event.user
    }));
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/slack/commands", async (req, res) => {
  try {
    if (!verifySlackSignature(req)) {
      return res.status(401).json({ ok: false, error: "Invalid Slack signature" });
    }

    const params = new URLSearchParams(req.body.toString("utf8"));
    const text = params.get("text") || "";
    const responseUrl = params.get("response_url") || "";
    const channel = params.get("channel_id") || "";
    const userId = params.get("user_id") || "";

    res.json({
      response_type: "ephemeral",
      text: "Working on it..."
    });

    runInBackground(processSlackCommand({
      text,
      fallbackWorkspace: config.slackDefaultProject,
      responseUrl,
      channel,
      userId
    }));

    return;
  } catch (error) {
    return res.json({
      response_type: "ephemeral",
      text: `Blue command failed: ${error.message}`
    });
  }
});

app.post("/slack/interactions", async (req, res) => {
  try {
    if (!verifySlackSignature(req)) {
      return res.status(401).json({ ok: false, error: "Invalid Slack signature" });
    }

    const params = new URLSearchParams(req.body.toString("utf8"));
    const payload = JSON.parse(params.get("payload") || "{}");

    if (payload.type !== "block_actions") {
      return res.json({ ok: true, ignored: true });
    }

    const action = payload.actions?.[0];
    if (!action) {
      return res.json({ ok: true, ignored: true });
    }

    if (action.action_id === "blue_cancel_workspace_selection") {
      return res.json({
        replace_original: true,
        text: "Canceled."
      });
    }

    if (action.action_id !== "blue_select_workspace" && action.action_id !== "blue_select_task") {
      return res.json({ ok: true, ignored: true });
    }

    const command = fromSlackJson(action.value);
    const workspaceResolution = await maybeResolveWorkspace(command);
    if (workspaceResolution) {
      return res.json(workspaceResolution.payload);
    }

    const taskResolution = await maybeResolveTask(command);
    if (taskResolution) {
      return res.json(taskResolution.payload);
    }

    const result = await dispatchParsedCommand(command);
    const message = slackResultText(result);

    if (isPublicSuccessAction(result.action) && payload.channel?.id) {
      await postSlackMessage(payload.channel.id, message, payload.message?.thread_ts || payload.message?.ts);
      return res.json({
        replace_original: true,
        text: "Done. I posted the update in the channel."
      });
    }

    return res.json({
      replace_original: true,
      response_type: "ephemeral",
      text: message
    });
  } catch (error) {
    return res.json({
      replace_original: true,
      response_type: "ephemeral",
      text: `Blue command failed: ${error.message}`
    });
  }
});

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname.replaceAll("/", "\\").endsWith(
    process.argv[1].replaceAll("/", "\\")
  );

if (isDirectRun) {
  app.listen(config.httpPort, () => {
    console.log(`Blue integration HTTP server listening on http://localhost:${config.httpPort}`);
  });
}

export default app;
