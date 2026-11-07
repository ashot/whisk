// One send across several transports. Devices name which transport carries
// them; the router groups them, calls each once, and folds the results into
// one answer — including the dead tokens the caller should clear.

import {
  consoleLogger,
  dedupeTargets,
  emptyResult,
  type DeliveryResult,
  type Logger,
  type PushMessage,
  type PushTarget,
  type PushTransport,
} from "./types";

export interface PushRouterConfig {
  /** Keyed by transport name: "expo", "apns", or the app's own. */
  transports: Record<string, PushTransport>;
  /** Transport for a device that names none. Defaults to the only one. */
  defaultTransport?: string;
  logger?: Logger;
}

export interface PushRouter {
  send(targets: PushTarget[], message: PushMessage): Promise<DeliveryResult>;
}

export function createPushRouter(config: PushRouterConfig): PushRouter {
  const names = Object.keys(config.transports);
  const fallback =
    config.defaultTransport ?? (names.length === 1 ? names[0] : undefined);
  const log = config.logger ?? consoleLogger;

  return {
    async send(targets: PushTarget[], message: PushMessage): Promise<DeliveryResult> {
      const total = emptyResult();
      // Dedupe across transports first: one token is one device, whoever
      // carries it.
      const { unique, deduped } = dedupeTargets(targets);
      total.deduped = deduped;

      const groups = new Map<string, PushTarget[]>();
      for (const target of unique) {
        const name = target.transport ?? fallback;
        if (!name || !config.transports[name]) {
          const detail = `no transport for token ${target.token} (${
            target.transport ?? "unnamed"
          })`;
          log.warn(`[push] ${detail}`);
          total.errors.push(detail);
          continue;
        }
        const list = groups.get(name);
        if (list) list.push(target);
        else groups.set(name, [target]);
      }

      for (const [name, group] of groups) {
        const result = await config.transports[name].send(group, message);
        total.sent += result.sent;
        total.deduped += result.deduped;
        total.deadTokens.push(...result.deadTokens);
        total.errors.push(...result.errors);
      }
      return total;
    },
  };
}
