// @platform/push — presence aware push routing: hold a push while a device is
// in use, collapse a burst into one, cancel it when the item is read, and fall
// back to a counted digest. Extracted from codecast's pushRouter, with the
// event taxonomy and every database read injected by the app.

// Policy
export {
  AWAY_DEBOUNCE_MS,
  BATCH_SLACK_MS,
  DEFAULT_PUSH_POLICY,
  HOLD_WHILE_ACTIVE_MS,
  INPUT_ACTIVE_MS,
  MAX_HOLD_MS,
  PRESENCE_FRESH_MS,
  decideFlush,
  dueRows,
  isClientActive,
  isClientAlive,
  isMachineActive,
  resolvePresence,
  scheduleDecision,
  type FlushInput,
  type FlushPlan,
  type MachineDevice,
  type NewOutboxRow,
  type OutboxPatch,
  type OutboxRow,
  type Presence,
  type PresenceInput,
  type PresenceRow,
  type PushPolicy,
} from "./policy";

// Digest
export { buildDigest, type DigestOptions, type TypeLabels } from "./digest";

// Outbox
export {
  enqueuePush,
  flushPush,
  type EnqueueRequest,
  type EnqueueResult,
  type FlushResult,
  type PushOutboxConfig,
  type PushOutboxHooks,
  type PushRecipient,
} from "./outbox";

// Transports
export {
  APNS_HOSTS,
  EXPO_PUSH_ENDPOINT,
  VOIP_TOPIC_SUFFIX,
  apnsAlertPayload,
  apnsConfigFromEnv,
  apnsConfigured,
  chunk,
  consoleLogger,
  createApnsTransport,
  createApnsVoipSender,
  createExpoTransport,
  createPushRouter,
  dedupeTargets,
  emptyResult,
  expoMessageFor,
  pemToPkcs8,
  sendApns,
  voipPayload,
  webCryptoSigner,
  type ApnsConfig,
  type ApnsEnvironment,
  type ApnsRequest,
  type ApnsResponse,
  type ApnsSigner,
  type DeliveryResult,
  type ExpoTransportConfig,
  type FetchLike,
  type Logger,
  type PushMessage,
  type PushRouter,
  type PushRouterConfig,
  type PushTarget,
  type PushTransport,
  type VoipRing,
  type VoipSender,
} from "./transports/index";
