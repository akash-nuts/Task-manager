import crypto from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { findWorkspaceMatches } from "./blue-api.js";
import { dispatchHumanCommand, dispatchParsedCommand, parseHumanCommand } from "./task-router.js";

const app = express();

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

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

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

function slackResultText(result) {
  const workspace = result.workspace || result.project || "Blue";
  const list = result.list ? ` in ${result.list}` : "";

  if (!result?.result || typeof result.result === "string") {
    return `Completed in ${workspace}${list}.\n${result.result || ""}`.trim();
  }

  if (typeof result.result === "object" && Number.isInteger(result.result.createdCount)) {
    const items = result.result.created || [];
    const lines = [`Created ${result.result.createdCount} tasks successfully in ${workspace}${list}.`];

    items.forEach((task, index) => {
      const link = buildBlueTaskUrl(task);
      const assignees = formatAssignees(task.assignees);
      const description = task.description ? ` Description: ${task.description}` : "";
      lines.push(
        `${index + 1}. ${task.title}${assignees ? ` | Assignee: ${assignees}` : ""}${description}${
          link ? ` | Link: ${link}` : ""
        }`
      );
    });

    return lines.join("\n");
  }

  if (typeof result.result === "object" && result.result.title) {
    const link = buildBlueTaskUrl(result.result);
    const assignees = formatAssignees(result.result.assignees);
    const description = result.result.description ? ` Description: ${result.result.description}` : "";
    return [
      `Created task "${result.result.title}" successfully in ${workspace}${list}.`,
      assignees ? `Assignee: ${assignees}.` : null,
      description ? description.trim() : null,
      link ? `Link: ${link}` : null
    ]
      .filter(Boolean)
      .join("\n");
  }

  return `Completed in ${workspace}${list}.\n${JSON.stringify(result.result, null, 2)}`;
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
  if (!task || !config.blueTaskUrlTemplate) {
    return null;
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

function buildWorkspaceSelectionResponse(command, candidates, { noGoodMatch = false } = {}) {
  const subject =
    command.action === "create"
      ? `create "${command.payload.title}"`
      : command.action === "bulk_create"
        ? `create ${command.payload.titles.length} tasks`
      : command.action === "search"
        ? `search for "${command.payload.query}"`
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

async function postSlackMessage(channel, text, threadTs) {
  if (!config.slackBotToken) {
    return;
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slackBotToken}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      channel,
      text,
      thread_ts: threadTs || undefined
    })
  });

  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(`Slack chat.postMessage failed: ${payload.error || "unknown_error"}`);
  }
}

async function postSlackResponse(responseUrl, text) {
  if (!responseUrl) {
    return;
  }

  await fetch(responseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      response_type: "ephemeral",
      text
    })
  });
}

async function processSlackCommand({ text, fallbackWorkspace, channel, threadTs, responseUrl }) {
  try {
    const result = await dispatchHumanCommand(text, fallbackWorkspace);
    const message = slackResultText(result);

    if (responseUrl) {
      await postSlackResponse(responseUrl, message);
    } else if (channel) {
      await postSlackMessage(channel, message, threadTs);
    }

    return { ok: true, result };
  } catch (error) {
    const message = `Blue command failed: ${error.message}`;

    if (responseUrl) {
      await postSlackResponse(responseUrl, message);
    } else if (channel && config.slackBotToken) {
      await postSlackMessage(channel, message, threadTs);
    }

    return { ok: false, error: error.message };
  }
}

async function prepareSlackCommandResponse({ text, fallbackWorkspace }) {
  const command = parseHumanCommand(text, fallbackWorkspace);
  const workspaceRef = command.payload?.workspace;

  if ((command.action === "create" || command.action === "bulk_create" || command.action === "search") && workspaceRef) {
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
    const result = await dispatchParsedCommand(command);
    return {
      type: "result",
      payload: {
        response_type: "ephemeral",
        text: slackResultText(result)
      }
    };
  }

  const result = await dispatchParsedCommand(command);
  return {
    type: "result",
    payload: {
      response_type: "ephemeral",
      text: slackResultText(result)
    }
  };
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

    void processSlackCommand({
      text,
      fallbackWorkspace: workspace,
      channel: event.channel,
      threadTs: event.thread_ts || event.ts
    });
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
    const outcome = await prepareSlackCommandResponse({
      text,
      fallbackWorkspace: config.slackDefaultProject
    });

    return res.json(outcome.payload);
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

    if (action.action_id !== "blue_select_workspace") {
      return res.json({ ok: true, ignored: true });
    }

    const command = fromSlackJson(action.value);
    const result = await dispatchParsedCommand(command);

    return res.json({
      replace_original: true,
      text: slackResultText(result)
    });
  } catch (error) {
    return res.json({
      replace_original: true,
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
