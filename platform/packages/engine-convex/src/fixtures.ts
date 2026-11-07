import type { ChangeLogConfig } from './changeLog'
import type { SyncLogConfig } from './syncLog'

/**
 * A catalog for the tests, standing in for an app's.
 *
 * It is codecast's, because that is the shape the spine was extracted from: five
 * tracked tables, a scope of owner plus team, conversations visible to their
 * owner alone, and a churn list for the counters a streaming session bumps on
 * every message flush.
 */

export const TRACKED_TABLES: ReadonlySet<string> = new Set([
  'conversations',
  'tasks',
  'docs',
  'plans',
  'projects',
])

export const changeLogConfig: ChangeLogConfig = {
  trackedTables: TRACKED_TABLES,
  membership: { table: 'team_memberships' },
}

export const syncLogConfig: SyncLogConfig = {
  ownerOnlyEntities: new Set(['conversations']),
  churnOnlyFields: {
    conversations: new Set([
      'updated_at',
      'message_count',
      'last_message_at',
      'last_message_role',
      'last_heartbeat',
      'last_metrics_at',
      'last_active_at',
      'model',
      'effort',
      'last_user_message_at',
      'last_message_preview',
      'image_preview_url',
      'recent_files',
    ]),
  },
}
