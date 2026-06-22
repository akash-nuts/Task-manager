import crypto from "node:crypto";
import { config } from "./config.js";

const EVENT_INDEX_KEY = "blue:summary:events:index";

function hasKvConfig() {
  return Boolean(config.kvRestApiUrl && config.kvRestApiToken);
}

function ensureKvConfig() {
  if (!hasKvConfig()) {
    throw new Error(
      "Missing KV storage configuration. Set KV_REST_API_URL and KV_REST_API_TOKEN in Vercel."
    );
  }
}

async function kvCommand(command) {
  ensureKvConfig();

  const response = await fetch(config.kvRestApiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.kvRestApiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`KV request failed with status ${response.status}${text ? `: ${text}` : ""}.`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(`KV error: ${payload.error}`);
  }

  return payload.result;
}

export function isSummaryStoreConfigured() {
  return hasKvConfig();
}

export async function addSummaryEvent(event) {
  ensureKvConfig();

  const occurredAt = Number(event.occurredAt || Date.now());
  const eventId = event.eventId || crypto.randomUUID();
  const key = `blue:summary:event:${occurredAt}:${eventId}`;
  const ttlSeconds = Math.max(60, Math.floor(config.summaryRetentionHours * 60 * 60));
  const serialized = JSON.stringify({
    ...event,
    eventId,
    occurredAt
  });

  await Promise.all([
    kvCommand(["SET", key, serialized, "EX", String(ttlSeconds)]),
    kvCommand(["ZADD", EVENT_INDEX_KEY, String(occurredAt), key])
  ]);

  return { key, eventId };
}

export async function getSummaryEventsBetween(startMs, endMs) {
  ensureKvConfig();

  const keys = await kvCommand([
    "ZRANGEBYSCORE",
    EVENT_INDEX_KEY,
    String(startMs),
    String(endMs)
  ]);

  if (!Array.isArray(keys) || !keys.length) {
    return [];
  }

  const values = await kvCommand(["MGET", ...keys]);
  return (Array.isArray(values) ? values : [])
    .map((value) => {
      try {
        return value ? JSON.parse(value) : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function cleanupSummaryEvents(beforeMs) {
  if (!hasKvConfig()) {
    return { removed: 0 };
  }

  const removed = await kvCommand([
    "ZREMRANGEBYSCORE",
    EVENT_INDEX_KEY,
    "-inf",
    String(beforeMs)
  ]);

  return { removed: Number(removed || 0) };
}
