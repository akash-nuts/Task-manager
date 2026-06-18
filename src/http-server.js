import crypto from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { dispatchHumanCommand } from "./task-router.js";

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
  const header = `Workspace: ${result.workspace || result.project}`;
  const body =
    typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2);
  return `${header}\n${body}`;
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
    const responseUrl = params.get("response_url") || "";
    const channelId = params.get("channel_id") || "";

    res.json({
      response_type: "ephemeral",
      text: "Working on it..."
    });

    void processSlackCommand({
      text,
      fallbackWorkspace: config.slackDefaultProject,
      channel: channelId,
      responseUrl
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.listen(config.httpPort, () => {
  console.log(`Blue integration HTTP server listening on http://localhost:${config.httpPort}`);
});
