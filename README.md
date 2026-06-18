# Blue MCP Integration

This project adds a first-pass integration layer for Blue so you can manage tasks across multiple Blue workspaces from:

- Codex through MCP
- Slack through Events API or a slash command
- Email through an inbound webhook

WhatsApp can be added later by routing its webhook into the same command dispatcher.

## Architecture

- `src/mcp-server.js`
  Exposes structured MCP tools like `create_task`, `update_task`, `search_tasks`, and `comment_task`.
- `src/http-server.js`
  Accepts Slack and email webhook traffic and converts human messages into Blue task actions.
- `src/blue-cli.js`
  Uses Blue's official CLI as the transport layer instead of hard-coding GraphQL mutations.
- `src/task-router.js`
  Normalizes task actions so every channel uses the same path into Blue.

## Why Blue CLI First

Blue's public docs and official GitHub repos show a supported CLI with records, comments, search, lists, IDs, webhooks, and multi-company support. Using that as the first transport keeps this integration aligned with Blue's own surface area and avoids guessing at GraphQL schema details.

## Prerequisites

1. Install the Blue CLI from Blue Team's repo:
   - Repo: https://github.com/heyblueteam/cli
2. Run `blue init`
3. Verify access with:

```bash
blue workspaces list --simple
```

4. Copy the project config:

```bash
copy blue-projects.example.json blue-projects.local.json
```

5. Fill in your Blue project mapping:
   - `company`
   - `workspaceId`
   - `listId`

## Environment

Copy `.env.example` to `.env` and set:

- `BLUE_CLI_PATH`
- `API_URL`
- `AUTH_TOKEN`
- `CLIENT_ID`
- `COMPANY_ID`
- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- `SLACK_COMMAND_NAME`
- `EMAIL_SHARED_SECRET`
- `HTTP_PORT`

The Blue CLI supports project-level environment variables, and this integration passes the root `.env` values through when it invokes the CLI. That means you can keep your Blue credentials in this repo-local `.env` instead of `C:\Users\ADMIN\.config\blue\config.env`.

## Install

```bash
npm install
```

## Run

HTTP adapters:

```bash
npm run start:http
```

MCP server:

```bash
npm run start:mcp
```

## Replit Deploy

This project can be deployed to Replit as the public Slack/email webhook service.

Replit should run the HTTP server, not the MCP stdio server.

Included files:

- `.replit`
- `replit.nix`

Run command on Replit:

```bash
npm run start:http
```

Set these Replit Secrets:

- `API_URL`
- `CLIENT_ID`
- `AUTH_TOKEN`
- `COMPANY_ID`
- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- `SLACK_COMMAND_NAME`
- `EMAIL_SHARED_SECRET`
- `HTTP_PORT`

Recommended values:

```env
SLACK_COMMAND_NAME=/blue
HTTP_PORT=8787
```

After publishing on Replit, use your public app URL for:

- `https://your-app.replit.app/slack/events`
- `https://your-app.replit.app/slack/commands`
- `https://your-app.replit.app/email/inbound`
- `https://your-app.replit.app/health`

Slack setup after deployment:

1. In `Event Subscriptions`, set the Request URL to `/slack/events`
2. Subscribe to `app_mention`
3. In `Slash Commands`, set the Request URL to `/slack/commands`
4. Reinstall the Slack app if you changed scopes
5. Invite the bot into the channel where you want to use it

## Codex MCP Config

Example client config:

```json
{
  "mcpServers": {
    "blue": {
      "command": "node",
      "args": ["D:/VS/Blue App/src/mcp-server.js"]
    }
  }
}
```

There is also a sample file in `codex-mcp.example.json`.

## Multi-Workspace Use

You are not limited to one workspace.

The MCP server can resolve Blue workspaces dynamically by name or ID on each request. Optional aliases can still live in `blue-projects.local.json`, but they are no longer required for every workspace.

Examples:

- `create in MA-EU: Fix login timeout`
- `search in 4ay-AI-CRM: onboarding`
- `move rec_123 to Done`

## Slack Setup

This version supports a lightweight command syntax:

- `create in MA-EU: Fix login timeout`
- `search in 4ay-AI-CRM: onboarding`
- `comment rec_123: Please prioritize this`
- `move rec_123 to Done`

You can use either:

1. Slack Events API
2. A slash command like `/blue`

Endpoints:

```text
POST /slack/events
POST /slack/commands
```

Recommended Slack app setup:

1. Create a Slack app.
2. Enable Event Subscriptions and point it to `/slack/events`.
3. Subscribe to `app_mention` events.
4. Add OAuth bot scopes:
   - `app_mentions:read`
   - `chat:write`
   - `channels:history`
   - `groups:history`
   - `im:history`
   - `mpim:history`
5. Install the app into your workspace.
6. Add these values to `.env`:
   - `SLACK_SIGNING_SECRET`
   - `SLACK_BOT_TOKEN`

Optional slash command setup:

1. Add a slash command named `SLACK_COMMAND_NAME`, default `/blue`
2. Point it to `/slack/commands`
3. Then use commands like:

```text
/blue create in MA-EU: Fix login timeout
/blue search in 4ay-AI-CRM: onboarding
```

## Email Commands

Send a POST request from your inbound email processor to:

```text
POST /email/inbound
```

Example body:

```json
{
  "subject": "create in mobile: Fix push notification retry",
  "text": "create in mobile: Fix push notification retry",
  "project": "mobile"
}
```

Provide the header:

```text
x-email-shared-secret: <EMAIL_SHARED_SECRET>
```

Supported fields include:

- `text`
- `subject`
- `stripped-text`
- `body_plain`
- `plain`

That means services like Mailgun, Postmark, and SendGrid can usually be adapted without changing the app.

## Deploying For Slack/Email

Slack and email providers need a public URL. For local testing, use a tunnel like `ngrok` or `cloudflared`. For ongoing use, deploy the HTTP server to a public host such as Render, Railway, Fly.io, or a VPS.

Example local test flow:

```bash
npm run start:http
ngrok http 8787
```

Then use the generated HTTPS URL for:

- `https://<your-url>/slack/events`
- `https://<your-url>/slack/commands`
- `https://<your-url>/email/inbound`

## MCP Tools

- `list_projects`
- `list_workspaces`
- `list_workspace_lists`
- `create_task`
- `update_task`
- `move_task`
- `comment_task`
- `search_tasks`
- `list_tasks`

## WhatsApp Later

To add WhatsApp later, reuse `dispatchHumanCommand()` from `src/task-router.js` and attach it to your WhatsApp webhook provider. No Blue-specific logic needs to change.

## Notes

- This scaffold assumes the Blue CLI is installed and authenticated.
- Blue CLI output may differ slightly across versions, so live testing against your workspace is still needed.
- If you want, the next step can be a second transport that talks directly to Blue GraphQL or the official `bluepm` Python SDK for richer typed operations.
