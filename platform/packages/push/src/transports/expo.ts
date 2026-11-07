// Expo push. One HTTP call carries up to a hundred messages, so a fan out to
// many devices is one request.
//
// Deliverability hygiene: a DeviceNotRegistered receipt means the token is
// dead (app removed, token rotated). The transport reports it back as a dead
// token so the caller can clear it, which stops the outbox queueing pushes
// nobody can receive and lets the next app launch register a fresh one.

import {
  chunk,
  consoleLogger,
  dedupeTargets,
  emptyResult,
  type DeliveryResult,
  type FetchLike,
  type Logger,
  type PushMessage,
  type PushTarget,
  type PushTransport,
} from "./types";

export const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const MAX_PER_REQUEST = 100;

export interface ExpoTransportConfig {
  endpoint?: string;
  fetch?: FetchLike;
  logger?: Logger;
  /** EXPO_ACCESS_TOKEN, for projects with push security enabled. */
  accessToken?: string;
  /** Sound when a message names none. "default" rings the standard tone. */
  defaultSound?: string;
}

interface ExpoTicket {
  status?: string;
  message?: string;
  details?: { error?: string };
}

export function expoMessageFor(
  target: PushTarget,
  message: PushMessage,
  defaultSound = "default",
): Record<string, unknown> {
  return {
    to: target.token,
    sound: message.sound ?? defaultSound,
    title: message.title,
    ...(message.subtitle ? { subtitle: message.subtitle } : {}),
    body: message.body,
    data: message.data ?? {},
    priority: message.priority ?? "high",
    ...(message.channelId ? { channelId: message.channelId } : {}),
    ...(message.interruptionLevel
      ? { interruptionLevel: message.interruptionLevel }
      : {}),
    ...(message.categoryId ? { categoryId: message.categoryId } : {}),
    ...(message.ttlSeconds !== undefined ? { ttl: message.ttlSeconds } : {}),
    ...(message.badge !== undefined ? { badge: message.badge } : {}),
    ...(message.contentAvailable ? { _contentAvailable: true } : {}),
  };
}

export function createExpoTransport(config: ExpoTransportConfig = {}): PushTransport {
  const endpoint = config.endpoint ?? EXPO_PUSH_ENDPOINT;
  const doFetch: FetchLike = config.fetch ?? ((input, init) => fetch(input, init));
  const log = config.logger ?? consoleLogger;
  const defaultSound = config.defaultSound ?? "default";

  return {
    name: "expo",
    async send(targets: PushTarget[], message: PushMessage): Promise<DeliveryResult> {
      const result = emptyResult();
      const { unique, deduped } = dedupeTargets(targets);
      result.deduped = deduped;
      if (unique.length === 0) return result;

      for (const batch of chunk(unique, MAX_PER_REQUEST)) {
        const body = batch.map((t) => expoMessageFor(t, message, defaultSound));
        let res: Response;
        try {
          res = await doFetch(endpoint, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              ...(config.accessToken
                ? { Authorization: `Bearer ${config.accessToken}` }
                : {}),
            },
            body: JSON.stringify(body),
          });
        } catch (err) {
          // Logged, not retried: the next event queues its own push.
          const detail = `expo push failed: ${String(err)}`;
          log.warn(`[push] ${detail}`);
          result.errors.push(detail);
          continue;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const detail = `expo push rejected: ${res.status} ${text}`.trim();
          log.warn(`[push] ${detail}`);
          result.errors.push(detail);
          continue;
        }

        let tickets: ExpoTicket[] = [];
        try {
          const payload = (await res.json()) as { data?: ExpoTicket | ExpoTicket[] };
          const data = payload?.data;
          tickets = Array.isArray(data) ? data : data ? [data] : [];
        } catch {
          // A 200 with an unreadable body still delivered; count it and move on.
          result.sent += batch.length;
          continue;
        }

        batch.forEach((target, i) => {
          const ticket = tickets[i];
          if (!ticket || ticket.status === "ok") {
            result.sent++;
            return;
          }
          if (ticket.details?.error === "DeviceNotRegistered") {
            result.deadTokens.push(target.token);
          }
          const detail = `expo push error for ${target.token}: ${
            ticket.details?.error ?? ticket.message ?? "unknown"
          }`;
          log.warn(`[push] ${detail}`);
          result.errors.push(detail);
        });
      }
      return result;
    },
  };
}
