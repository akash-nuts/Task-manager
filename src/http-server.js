import crypto from "node:crypto";
import express from "express";
import { waitUntil } from "@vercel/functions";
import { config } from "./config.js";
import { findWorkspaceMatches, getRecord, listLists, listWorkspaces, searchRecords } from "./blue-api.js";
import { buildDailySummary } from "./summary-service.js";
import { addSummaryEvent, isSummaryStoreConfigured } from "./summary-store.js";
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
      blueWebhook: "/blue/webhooks",
      dailySummary: "/cron/daily-summary",
      debugWorkspaces: "/debug/workspaces",
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

function buildBlueTaskUrl(task, options = {}) {
  if (!task) {
    return null;
  }

  const workspaceSlug = task.list?.workspaceSlug || options.workspaceSlug || "";
  const workspaceId = task.list?.workspaceId || options.workspaceId || "";

  if (!config.blueTaskUrlTemplate) {
    if (!workspaceSlug || !task.id) {
      return null;
    }

    return `${config.blueWebBaseUrl}/org/${config.blueCompanyId}/workspace/${workspaceSlug}/records/board/${task.id}`;
  }

  return config.blueTaskUrlTemplate
    .replaceAll("{baseUrl}", config.blueWebBaseUrl)
    .replaceAll("{companyId}", config.blueCompanyId)
    .replaceAll("{workspaceSlug}", workspaceSlug)
    .replaceAll("{workspaceId}", workspaceId)
    .replaceAll("{taskUid}", task.uid || "")
    .replaceAll("{taskId}", task.id || "");
}

function toSlackJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function fromSlackJson(value) {
  return JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
}

function parseSharedSecret(req, headerName) {
  const authHeader = req.header("authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return (
    req.header(headerName) ||
    req.query?.secret ||
    req.body?.secret ||
    bearerMatch?.[1] ||
    ""
  );
}

function verifySharedSecret(req, expectedSecret, headerName) {
  if (!expectedSecret) {
    return true;
  }

  const providedSecret = parseSharedSecret(req, headerName);
  return providedSecret === expectedSecret;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === 0) {
      return value;
    }

    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }

  return "";
}

function normalizeBlueWebhookPayload(body = {}) {
  const payload = body?.data || body?.record || body?.todo || body;
  const taskPayload =
    payload?.record ||
    payload?.todo ||
    payload?.task ||
    payload?.data?.record ||
    payload?.data?.todo ||
    body?.record ||
    body?.todo ||
    body?.task ||
    null;

  const currentList =
    taskPayload?.list?.name ||
    taskPayload?.todoList?.title ||
    payload?.list?.name ||
    body?.list?.name ||
    "";
  const fromList =
    firstNonEmpty(
      body?.fromList?.name,
      body?.fromListName,
      body?.previousList?.name,
      body?.oldList?.name,
      payload?.fromList?.name,
      payload?.previousList?.name,
      taskPayload?.fromList?.name
    ) || "";
  const toList =
    firstNonEmpty(
      body?.toList?.name,
      body?.toListName,
      body?.newList?.name,
      payload?.toList?.name,
      payload?.newList?.name,
      taskPayload?.toList?.name,
      currentList
    ) || "";

  return {
    eventType: firstNonEmpty(body?.eventType, body?.type, body?.trigger, body?.event, payload?.eventType) || "blue_event",
    taskId: firstNonEmpty(
      taskPayload?.id,
      taskPayload?._id,
      payload?.recordId,
      payload?.todoId,
      body?.recordId,
      body?.todoId,
      body?.taskId
    ),
    taskTitle: firstNonEmpty(taskPayload?.title, payload?.title, body?.title),
    workspaceId: firstNonEmpty(
      taskPayload?.list?.workspaceId,
      taskPayload?.todoList?.project?.id,
      payload?.workspaceId,
      body?.workspaceId,
      body?.projectId
    ),
    workspaceName: firstNonEmpty(
      taskPayload?.list?.workspace,
      taskPayload?.todoList?.project?.name,
      payload?.workspaceName,
      body?.workspaceName
    ),
    workspaceSlug: firstNonEmpty(
      taskPayload?.list?.workspaceSlug,
      taskPayload?.todoList?.project?.slug,
      payload?.workspaceSlug,
      body?.workspaceSlug
    ),
    fromList,
    toList,
    occurredAt: new Date(
      firstNonEmpty(body?.occurredAt, body?.createdAt, body?.timestamp, payload?.createdAt, Date.now())
    ).getTime()
  };
}

async function enrichSummaryEvent(event) {
  if (!event?.taskId) {
    return event;
  }

  try {
    const record = (
      await getRecord(event.taskId, {
        projectId: event.workspaceId || undefined
      })
    ).data;

    return {
      ...event,
      taskTitle: event.taskTitle || record?.title || "",
      workspaceId: event.workspaceId || record?.list?.workspaceId || "",
      workspaceName: event.workspaceName || record?.list?.workspace || "",
      workspaceSlug: event.workspaceSlug || record?.list?.workspaceSlug || "",
      toList: event.toList || record?.list?.name || "",
      assignees: Array.isArray(record?.assignees) ? record.assignees : []
    };
  } catch (error) {
    console.warn("Failed to enrich Blue summary event:", error.message);
    return event;
  }
}

function isPublicSuccessAction(action) {
  return ["create", "bulk_create", "bulk_import", "update", "move", "comment"].includes(action);
}

function taskSummaryLine(task, index, { includeWorkspace = false, workspaceSlug = "", workspaceId = "" } = {}) {
  const link = buildBlueTaskUrl(task, { workspaceSlug, workspaceId });
  const assignees = formatAssignees(task.assignees);

  return `${index + 1}. ${task.title}${includeWorkspace ? ` | Workspace: ${task.list?.workspace || "Unknown"}` : ""} | Status: ${task.list?.name || "Unknown"}${
    assignees ? ` | Assignee: ${assignees}` : ""
  }${link ? ` | Link: ${link}` : ""}`;
}

function taskActionValue(task, channelId, userId) {
  return toSlackJson({
    recordId: task.id,
    title: task.title,
    workspaceId: task.list?.workspaceId || "",
    workspace: task.list?.workspace || "",
    channelId: channelId || "",
    userId: userId || ""
  });
}

function buildInteractiveTaskBlocks(result, channelId, userId) {
  const tasks = Array.isArray(result.result) ? result.result : [];
  const workspace = result.workspace || result.project || "Blue";
  const header =
    result.allWorkspaces
      ? `Tasks across ${result.matchedWorkspaceCount || 0} workspaces assigned to ${result.assignee}${
          result.list ? ` in ${result.list}` : ""
        }:`
      : result.action === "search"
      ? `Top matching tasks in ${workspace} for "${result.query}"${
          result.assignee ? ` assigned to ${result.assignee}` : ""
        }:`
      : `Tasks in ${workspace}${result.list ? ` (${result.list})` : ""}${
          result.assignee ? ` assigned to ${result.assignee}` : ""
        }:`;

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: header
      }
    }
  ];

  tasks.slice(0, 5).forEach((task, index) => {
    const link = buildBlueTaskUrl(task, {
      workspaceSlug: result.workspaceSlug,
      workspaceId: result.workspaceId
    });
    const assignees = formatAssignees(task.assignees) || "Unassigned";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${index + 1}. ${task.title}*\n` +
          `${result.allWorkspaces ? `Workspace: ${task.list?.workspace || "Unknown"}\n` : ""}` +
          `Status: ${task.list?.name || "Unknown"}\n` +
          `Assignee: ${assignees}` +
          (link ? `\n<${link}|Open in Blue>` : "")
      }
    });

    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Comment"
          },
          action_id: "blue_open_comment_modal",
          value: taskActionValue(task, channelId, userId)
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Append Desc"
          },
          action_id: "blue_open_append_description_modal",
          value: taskActionValue(task, channelId, userId)
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Change Assignee"
          },
          action_id: "blue_open_assignee_modal",
          value: taskActionValue(task, channelId, userId)
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Change Status"
          },
          action_id: "blue_open_status_modal",
          value: taskActionValue(task, channelId, userId)
        }
      ]
    });
  });

  return blocks;
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
    items.forEach((task, index) =>
      lines.push(taskSummaryLine(task, index, { workspaceSlug: result.workspaceSlug, workspaceId: result.workspaceId }))
    );
    return lines.join("\n");
  }

  if (result.action === "bulk_import") {
    const items = result.result?.created || [];
    const errors = result.result?.errors || [];
    const warnings = result.result?.warnings || [];
    const lines = [
      `Imported ${result.result.createdCount} tasks into ${workspace}${list}.${warnings.length ? ` ${warnings.length} warnings.` : ""}${errors.length ? ` ${errors.length} rows failed.` : ""}`
    ];

    items.slice(0, 10).forEach((task, index) =>
      lines.push(taskSummaryLine(task, index, { workspaceSlug: result.workspaceSlug, workspaceId: result.workspaceId }))
    );

    if (warnings.length) {
      lines.push("Warnings:");
      warnings.slice(0, 10).forEach((warning) => {
        lines.push(`Row ${warning.rowNumber} (${warning.title}): ${warning.message}`);
      });
    }

    if (errors.length) {
      lines.push("Errors:");
      errors.slice(0, 10).forEach((error) => {
        lines.push(`Row ${error.rowNumber} (${error.title}): ${error.message}`);
      });
    }

    return lines.join("\n");
  }

  if (["create", "update", "move"].includes(result.action) && result.result?.title) {
    const link = buildBlueTaskUrl(result.result, {
      workspaceSlug: result.workspaceSlug,
      workspaceId: result.workspaceId
    });
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
    const link = buildBlueTaskUrl(result.result, {
      workspaceSlug: result.workspaceSlug,
      workspaceId: result.workspaceId
    });
    return [
      `Added a comment to "${result.result.title}" in ${workspace}.`,
      link ? `Link: ${link}` : null
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.action === "status" && result.result?.title) {
    const task = result.result;
    const link = buildBlueTaskUrl(task, {
      workspaceSlug: result.workspaceSlug,
      workspaceId: result.workspaceId
    });
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
      result.allWorkspaces
        ? `Tasks across ${result.matchedWorkspaceCount || 0} workspaces assigned to ${result.assignee}${
            result.list ? ` in ${result.list}` : ""
          }:`
        : result.action === "search"
        ? `Top matching tasks in ${workspace} for "${result.query}"${
            result.assignee ? ` assigned to ${result.assignee}` : ""
          }:`
        : `Tasks in ${workspace}${list}${result.assignee ? ` assigned to ${result.assignee}` : ""}:`;
    return [
      header,
      ...result.result.map((task, index) =>
        taskSummaryLine(task, index, {
          includeWorkspace: Boolean(result.allWorkspaces),
          workspaceSlug: result.workspaceSlug,
          workspaceId: result.workspaceId
        })
      )
    ].join("\n");
  }

  if (!result?.result || typeof result.result === "string") {
    return `Completed in ${workspace}${list}.\n${result.result || ""}`.trim();
  }

  return `Completed in ${workspace}${list}.\n${JSON.stringify(result.result, null, 2)}`;
}

function slackResponseForResult(result, { channelId, userId } = {}) {
  const payload = {
    response_type: isPublicSuccessAction(result.action) ? "in_channel" : "ephemeral",
    text: slackResultText(result)
  };

  if (["search", "list"].includes(result.action) && Array.isArray(result.result) && result.result.length) {
    payload.blocks = buildInteractiveTaskBlocks(result, channelId, userId);
  }

  return payload;
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

async function openSlackModal(triggerId, view) {
  return postSlackApi("views.open", {
    trigger_id: triggerId,
    view
  });
}

function modalMetadata(base) {
  return JSON.stringify(base);
}

function getViewInputValue(view, blockId, actionId) {
  return view?.state?.values?.[blockId]?.[actionId]?.value || "";
}

function getSelectedOptionValue(view, blockId, actionId) {
  return view?.state?.values?.[blockId]?.[actionId]?.selected_option?.value || "";
}

async function openCommentModal(triggerId, metadata) {
  return openSlackModal(triggerId, {
    type: "modal",
    callback_id: "blue_submit_comment_modal",
    title: {
      type: "plain_text",
      text: "Add Comment"
    },
    submit: {
      type: "plain_text",
      text: "Save"
    },
    close: {
      type: "plain_text",
      text: "Cancel"
    },
    private_metadata: modalMetadata(metadata),
    blocks: [
      {
        type: "input",
        block_id: "comment_block",
        label: {
          type: "plain_text",
          text: `Comment on ${metadata.title.slice(0, 60)}`
        },
        element: {
          type: "plain_text_input",
          action_id: "comment_value",
          multiline: true
        }
      }
    ]
  });
}

async function openAppendDescriptionModal(triggerId, metadata) {
  return openSlackModal(triggerId, {
    type: "modal",
    callback_id: "blue_submit_append_description_modal",
    title: {
      type: "plain_text",
      text: "Append Description"
    },
    submit: {
      type: "plain_text",
      text: "Append"
    },
    close: {
      type: "plain_text",
      text: "Cancel"
    },
    private_metadata: modalMetadata(metadata),
    blocks: [
      {
        type: "input",
        block_id: "append_block",
        label: {
          type: "plain_text",
          text: `Append to ${metadata.title.slice(0, 60)}`
        },
        element: {
          type: "plain_text_input",
          action_id: "append_value",
          multiline: true
        }
      }
    ]
  });
}

async function openAssigneeModal(triggerId, metadata) {
  return openSlackModal(triggerId, {
    type: "modal",
    callback_id: "blue_submit_assignee_modal",
    title: {
      type: "plain_text",
      text: "Change Assignee"
    },
    submit: {
      type: "plain_text",
      text: "Update"
    },
    close: {
      type: "plain_text",
      text: "Cancel"
    },
    private_metadata: modalMetadata(metadata),
    blocks: [
      {
        type: "input",
        block_id: "assignee_block",
        label: {
          type: "plain_text",
          text: `Assignee for ${metadata.title.slice(0, 60)}`
        },
        element: {
          type: "plain_text_input",
          action_id: "assignee_value",
          placeholder: {
            type: "plain_text",
            text: "Enter Blue assignee name"
          }
        }
      }
    ]
  });
}

async function openStatusModal(triggerId, metadata) {
  const lists = (await listLists(metadata.workspaceId)).data || [];
  return openSlackModal(triggerId, {
    type: "modal",
    callback_id: "blue_submit_status_modal",
    title: {
      type: "plain_text",
      text: "Change Status"
    },
    submit: {
      type: "plain_text",
      text: "Move"
    },
    close: {
      type: "plain_text",
      text: "Cancel"
    },
    private_metadata: modalMetadata(metadata),
    blocks: [
      {
        type: "input",
        block_id: "status_block",
        label: {
          type: "plain_text",
          text: `Move ${metadata.title.slice(0, 60)} to`
        },
        element: {
          type: "static_select",
          action_id: "status_value",
          options: lists.slice(0, 100).map((list) => ({
            text: {
              type: "plain_text",
              text: list.name
            },
            value: list.name
          }))
        }
      }
    ]
  });
}

async function handleModalSubmission(payload) {
  const metadata = JSON.parse(payload.view?.private_metadata || "{}");
  const channelId = metadata.channelId;
  const userId = metadata.userId || payload.user?.id;
  const postResult = async (result) => {
    const message = slackResultText(result);

    if (channelId) {
      await postSlackMessage(channelId, message);
      return;
    }

    if (userId) {
      await postSlackEphemeral(channelId, userId, message);
    }
  };

  if (payload.view.callback_id === "blue_submit_comment_modal") {
    const text = getViewInputValue(payload.view, "comment_block", "comment_value").trim();
    const result = await dispatchParsedCommand({
      action: "comment",
      payload: {
        recordId: metadata.recordId,
        workspace: metadata.workspace,
        workspaceId: metadata.workspaceId,
        text
      }
    });

    await postResult(result);
    return;
  }

  if (payload.view.callback_id === "blue_submit_append_description_modal") {
    const appendText = getViewInputValue(payload.view, "append_block", "append_value").trim();
    const current = (
      await getRecord(metadata.recordId, {
        projectId: metadata.workspaceId || undefined
      })
    ).data;
    const existingDescription = current.description || "";
    const mergedDescription = existingDescription
      ? `${existingDescription}\n\n${appendText}`
      : appendText;

    const result = await dispatchParsedCommand({
      action: "update",
      payload: {
        recordId: metadata.recordId,
        workspace: metadata.workspace,
        workspaceId: metadata.workspaceId,
        description: mergedDescription
      }
    });

    await postResult(result);
    return;
  }

  if (payload.view.callback_id === "blue_submit_assignee_modal") {
    const assignee = getViewInputValue(payload.view, "assignee_block", "assignee_value").trim();
    const result = await dispatchParsedCommand({
      action: "update",
      payload: {
        recordId: metadata.recordId,
        workspace: metadata.workspace,
        workspaceId: metadata.workspaceId,
        assignees: [assignee]
      }
    });

    await postResult(result);
    return;
  }

  if (payload.view.callback_id === "blue_submit_status_modal") {
    const list = getSelectedOptionValue(payload.view, "status_block", "status_value");
    const result = await dispatchParsedCommand({
      action: "move",
      payload: {
        recordId: metadata.recordId,
        workspace: metadata.workspace,
        workspaceId: metadata.workspaceId,
        list
      }
    });

    await postResult(result);
  }
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

async function prepareSlackCommandResponse({ text, fallbackWorkspace, channelId, userId }) {
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
    payload: slackResponseForResult(result, { channelId, userId })
  };
}

async function processSlackCommand({ text, fallbackWorkspace, channel, threadTs, responseUrl, userId }) {
  try {
    const outcome = await prepareSlackCommandResponse({
      text,
      fallbackWorkspace,
      channelId: channel,
      userId
    });

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
app.use("/blue/webhooks", express.json());
app.use("/blue/webhooks", express.urlencoded({ extended: true }));

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

app.post("/blue/webhooks", async (req, res) => {
  try {
    if (!verifySharedSecret(req, config.blueWebhookSecret, "x-blue-webhook-secret")) {
      return res.status(401).json({ ok: false, error: "Invalid Blue webhook secret" });
    }

    if (!isSummaryStoreConfigured()) {
      return res.status(503).json({
        ok: false,
        error: "Summary storage is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN."
      });
    }

    const normalizedEvent = normalizeBlueWebhookPayload(req.body || {});
    const event = await enrichSummaryEvent(normalizedEvent);

    if (!event.taskId && !event.workspaceId) {
      return res.status(400).json({
        ok: false,
        error: "Webhook payload did not include a task or workspace identifier."
      });
    }

    const stored = await addSummaryEvent(event);
    return res.json({
      ok: true,
      stored,
      event
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

async function runDailySummary(req, res) {
  try {
    if (!verifySharedSecret(req, config.cronSecret, "x-cron-secret")) {
      return res.status(401).json({ ok: false, error: "Invalid cron secret" });
    }

    const debug = String(req.query?.debug || req.body?.debug || "").toLowerCase() === "1";
    const summary = await buildDailySummary({ debug });
    const dryRun = String(req.query?.dryRun || req.body?.dryRun || "").toLowerCase() === "1";

    if (!dryRun) {
      if (!config.slackSummaryChannelId) {
        throw new Error("Missing SLACK_SUMMARY_CHANNEL_ID.");
      }

      if (!config.slackBotToken) {
        throw new Error("Missing SLACK_BOT_TOKEN.");
      }

      await postSlackMessage(config.slackSummaryChannelId, summary.text);
    }

    return res.json({
      ok: true,
      dryRun,
      debug,
      posted: !dryRun,
      ...summary
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function runWorkspaceDebug(req, res) {
  try {
    if (!verifySharedSecret(req, config.cronSecret, "x-cron-secret")) {
      return res.status(401).json({ ok: false, error: "Invalid cron secret" });
    }

    const result = await listWorkspaces();
    const workspaces = Array.isArray(result.data) ? result.data : [];
    const query = String(req.query?.q || req.body?.q || "").trim().toLowerCase();
    const filtered = query
      ? workspaces.filter((workspace) => {
          return (
            String(workspace.id || "").toLowerCase().includes(query) ||
            String(workspace.name || "").toLowerCase().includes(query) ||
            String(workspace.slug || "").toLowerCase().includes(query)
          );
        })
      : workspaces;

    return res.json({
      ok: true,
      companyId: config.blueCompanyId,
      totalCount: workspaces.length,
      filteredCount: filtered.length,
      items: filtered
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

app.get("/cron/daily-summary", runDailySummary);
app.post("/cron/daily-summary", express.json(), runDailySummary);
app.get("/debug/workspaces", runWorkspaceDebug);
app.post("/debug/workspaces", express.json(), runWorkspaceDebug);

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

    runInBackground(
      processSlackCommand({
        text,
        fallbackWorkspace: workspace,
        channel: event.channel,
        threadTs: event.thread_ts || event.ts,
        userId: event.user
      })
    );
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

    runInBackground(
      processSlackCommand({
        text,
        fallbackWorkspace: config.slackDefaultProject,
        responseUrl,
        channel,
        userId
      })
    );

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

    if (payload.type === "view_submission") {
      res.json({ response_action: "clear" });
      runInBackground(handleModalSubmission(payload));
      return;
    }

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

    const modalActions = [
      "blue_open_comment_modal",
      "blue_open_append_description_modal",
      "blue_open_assignee_modal",
      "blue_open_status_modal"
    ];

    if (modalActions.includes(action.action_id)) {
      const metadata = fromSlackJson(action.value);
      metadata.userId = payload.user?.id || metadata.userId;
      metadata.channelId = payload.channel?.id || metadata.channelId;

      if (action.action_id === "blue_open_comment_modal") {
        await openCommentModal(payload.trigger_id, metadata);
      } else if (action.action_id === "blue_open_append_description_modal") {
        await openAppendDescriptionModal(payload.trigger_id, metadata);
      } else if (action.action_id === "blue_open_assignee_modal") {
        await openAssigneeModal(payload.trigger_id, metadata);
      } else if (action.action_id === "blue_open_status_modal") {
        await openStatusModal(payload.trigger_id, metadata);
      }

      return res.json({ ok: true });
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
