// Direct APNs, for the two things a hosted push service cannot do: an alert
// with Apple's own headers, and a VoIP push.
//
// A VoIP push wakes a KILLED app and puts up the lock screen call UI. No push
// service offers that channel, so a ring goes straight to Apple, signed with an
// APNs auth key (.p8, ES256 — one key covers every app on the team and never
// expires).
//
// Everything identifying is configuration. Nothing here carries a real key,
// team id, or bundle id:
//
//   keyId     APNS_KEY_ID    the ten character key id from the developer portal
//   teamId    APNS_TEAM_ID   the Apple team id
//   authKey   APNS_AUTH_KEY  the .p8 contents, newlines escaped or literal
//   bundleId  APNS_BUNDLE_ID the app id; the VoIP topic appends ".voip"
//   environment APNS_ENV     production or sandbox

import {
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

export const APNS_HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;

export type ApnsEnvironment = keyof typeof APNS_HOSTS;

/** Mints the provider token. Injectable so tests never need a real key. */
export type ApnsSigner = (claims: {
  keyId: string;
  teamId: string;
  authKey: string;
}) => Promise<string>;

export interface ApnsConfig {
  keyId?: string;
  teamId?: string;
  /** The .p8 file contents, PEM. */
  authKey?: string;
  /** The app id, e.g. "com.example.app". Never hard coded in this package. */
  bundleId: string;
  environment?: ApnsEnvironment;
  fetch?: FetchLike;
  logger?: Logger;
  signer?: ApnsSigner;
  /** Alert pushes with no explicit TTL expire after this many seconds. */
  defaultExpirySeconds?: number;
}

export function apnsConfigured(config: ApnsConfig): boolean {
  return !!(config.keyId && config.teamId && config.authKey);
}

/** Reads the standard environment variables. Nothing here has a default id. */
export function apnsConfigFromEnv(
  env: Record<string, string | undefined>,
  overrides: Partial<ApnsConfig> = {},
): ApnsConfig | null {
  const bundleId = overrides.bundleId ?? env.APNS_BUNDLE_ID;
  if (!bundleId) return null;
  return {
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    authKey: env.APNS_AUTH_KEY,
    bundleId,
    environment: (env.APNS_ENV as ApnsEnvironment) ?? "production",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Provider token
// ---------------------------------------------------------------------------

function base64Url(bytes: Uint8Array | ArrayBuffer): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer as ArrayBuffer;
}

/**
 * An ES256 JWT, valid twenty to sixty minutes. Minted per send: serverless
 * function instances are short lived, so caching across invocations buys
 * nothing.
 */
export const webCryptoSigner: ApnsSigner = async ({ keyId, teamId, authKey }) => {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(authKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const enc = new TextEncoder();
  const header = base64Url(enc.encode(JSON.stringify({ alg: "ES256", kid: keyId })));
  const claims = base64Url(
    enc.encode(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) })),
  );
  const input = `${header}.${claims}`;
  // WebCrypto ECDSA returns raw r||s, which is exactly the JWS form.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    enc.encode(input),
  );
  return `${input}.${base64Url(sig)}`;
};

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface ApnsRequest {
  token: string;
  payload: unknown;
  topic: string;
  pushType: "alert" | "voip" | "background";
  /** Unix seconds. Zero tells Apple to try once and give up. */
  expiration?: number;
  priority?: "5" | "10";
  collapseId?: string;
}

export interface ApnsResponse {
  ok: boolean;
  status: number;
  reason?: string;
  /** Apple says this token is dead. Clear it from the recipient. */
  dead: boolean;
}

const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered"]);

export async function sendApns(
  config: ApnsConfig,
  request: ApnsRequest,
): Promise<ApnsResponse> {
  const log = config.logger ?? consoleLogger;
  if (!apnsConfigured(config)) {
    log.warn("[push] APNs is not configured; skipping");
    return { ok: false, status: 0, reason: "not configured", dead: false };
  }
  const doFetch: FetchLike = config.fetch ?? ((input, init) => fetch(input, init));
  const sign = config.signer ?? webCryptoSigner;
  const host = APNS_HOSTS[config.environment ?? "production"];

  let jwt: string;
  try {
    jwt = await sign({
      keyId: config.keyId!,
      teamId: config.teamId!,
      authKey: config.authKey!,
    });
  } catch (err) {
    const detail = `APNs token minting failed: ${String(err)}`;
    log.error(`[push] ${detail}`);
    return { ok: false, status: 0, reason: detail, dead: false };
  }

  let res: Response;
  try {
    res = await doFetch(`${host}/3/device/${request.token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-topic": request.topic,
        "apns-push-type": request.pushType,
        "apns-priority": request.priority ?? "10",
        ...(request.expiration !== undefined
          ? { "apns-expiration": String(request.expiration) }
          : {}),
        ...(request.collapseId ? { "apns-collapse-id": request.collapseId } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(request.payload),
    });
  } catch (err) {
    // Logged, not retried.
    const detail = `APNs push failed: ${String(err)}`;
    log.error(`[push] ${detail}`);
    return { ok: false, status: 0, reason: detail, dead: false };
  }

  if (res.status === 200) return { ok: true, status: 200, dead: false };
  let reason: string | undefined;
  try {
    reason = ((await res.json()) as { reason?: string })?.reason;
  } catch {
    reason = undefined;
  }
  const dead = res.status === 410 || (!!reason && DEAD_TOKEN_REASONS.has(reason));
  log.error(`[push] APNs push failed: ${res.status} ${reason ?? ""}`.trim());
  return { ok: false, status: res.status, reason, dead };
}

/** Alert pushes: the same PushMessage the other transports carry. */
export function apnsAlertPayload(message: PushMessage): Record<string, unknown> {
  const data =
    message.data && typeof message.data === "object"
      ? (message.data as Record<string, unknown>)
      : {};
  return {
    aps: {
      alert: {
        title: message.title,
        ...(message.subtitle ? { subtitle: message.subtitle } : {}),
        body: message.body,
      },
      ...(message.badge !== undefined ? { badge: message.badge } : {}),
      sound: message.sound ?? "default",
      ...(message.interruptionLevel
        ? { "interruption-level": message.interruptionLevel }
        : {}),
      ...(message.categoryId ? { category: message.categoryId } : {}),
    },
    ...data,
  };
}

export function createApnsTransport(config: ApnsConfig): PushTransport {
  return {
    name: "apns",
    async send(targets: PushTarget[], message: PushMessage): Promise<DeliveryResult> {
      const result = emptyResult();
      const { unique, deduped } = dedupeTargets(targets);
      result.deduped = deduped;
      const ttl = message.ttlSeconds ?? config.defaultExpirySeconds;
      for (const target of unique) {
        const res = await sendApns(config, {
          token: target.token,
          payload: apnsAlertPayload(message),
          topic: config.bundleId,
          pushType: "alert",
          priority: message.priority === "default" ? "5" : "10",
          ...(ttl !== undefined
            ? { expiration: Math.floor(Date.now() / 1000) + ttl }
            : {}),
        });
        if (res.ok) result.sent++;
        else {
          if (res.dead) result.deadTokens.push(target.token);
          result.errors.push(`${res.status} ${res.reason ?? ""}`.trim());
        }
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// VoIP
// ---------------------------------------------------------------------------

/**
 * A ring. The payload shape is expo-callkit-telecom's IncomingCallEvent under
 * `incomingCall`, parsed natively before any JavaScript runs, so a cold start
 * ring needs no app side glue.
 */
export interface VoipRing {
  /** The call this ring belongs to. */
  callId: string;
  callerId: string;
  callerName: string;
  callerImage?: string;
  hasVideo?: boolean;
  /** Unique per ring attempt. Defaults to the call id plus the clock. */
  eventId?: string;
  startedAt?: string;
  /** Whatever the app needs to join. The library never reads it. */
  metadata?: Record<string, unknown>;
  /**
   * How long the ring stays worth delivering. A ring that arrives after the
   * invite expired is worthless, and a late VoIP push must still report a call
   * or the system kills the app, so never let a dead ring land minutes later.
   */
  ttlMs?: number;
}

export const VOIP_TOPIC_SUFFIX = ".voip";
const DEFAULT_RING_TTL_MS = 45_000;

export function voipPayload(ring: VoipRing, now = Date.now()): Record<string, unknown> {
  return {
    incomingCall: {
      eventId: ring.eventId ?? `${ring.callId}:${now}`,
      serverCallId: ring.callId,
      hasVideo: ring.hasVideo ?? false,
      startedAt: ring.startedAt ?? new Date(now).toISOString(),
      caller: {
        id: ring.callerId,
        displayName: ring.callerName,
        ...(ring.callerImage ? { avatarUrl: ring.callerImage } : {}),
      },
      ...(ring.metadata ? { metadata: ring.metadata } : {}),
    },
  };
}

export interface VoipSender {
  ring(token: string, ring: VoipRing): Promise<ApnsResponse>;
  /**
   * Proves the credentials without touching a device. Apple validates the
   * provider token before the device token, so BadDeviceToken (400) means the
   * key, team id, and key id are right; InvalidProviderToken (403) means they
   * are not.
   */
  probe(): Promise<ApnsResponse & { verdict: string }>;
}

export function createApnsVoipSender(config: ApnsConfig): VoipSender {
  const topic = `${config.bundleId}${VOIP_TOPIC_SUFFIX}`;
  const send = (token: string, payload: unknown, ttlMs: number) =>
    sendApns(config, {
      token,
      payload,
      topic,
      pushType: "voip",
      priority: "10",
      expiration: Math.floor((Date.now() + ttlMs) / 1000),
    });
  return {
    ring(token, ring) {
      return send(token, voipPayload(ring), ring.ttlMs ?? DEFAULT_RING_TTL_MS);
    },
    async probe() {
      if (!apnsConfigured(config)) {
        return {
          ok: false,
          status: 0,
          reason: "not configured",
          dead: false,
          verdict: "APNs environment is not set",
        };
      }
      const res = await send(
        "00".repeat(32),
        voipPayload({ callId: "probe", callerId: "probe", callerName: "probe" }),
        DEFAULT_RING_TTL_MS,
      );
      return {
        ...res,
        verdict:
          res.reason === "BadDeviceToken"
            ? "key accepted, token rejected as expected"
            : (res.reason ?? "unexpected"),
      };
    },
  };
}
