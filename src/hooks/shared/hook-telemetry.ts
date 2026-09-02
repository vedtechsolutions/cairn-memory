/**
 * Hook telemetry — records execution timing and outcomes.
 * Wrapped in try/catch: telemetry failure never blocks a hook.
 * Accepts an optional DB handle to avoid opening a third connection per hook.
 */
import type Database from 'better-sqlite3';
import { createHookDbClient } from './db-client.js';
import { ENV } from '../../constants/env.js';

export function recordTelemetry(
  hookName: string,
  eventType: string,
  startTime: number,
  success: boolean,
  error?: string,
  metadata?: Record<string, unknown>,
  db?: Database.Database,
): void {
  try {
    const durationMs = Date.now() - startTime;
    let database: Database.Database;
    let ownedDb = false;

    if (db) {
      database = db;
    } else {
      const dbPath = process.env[ENV.DB_PATH] ?? undefined;
      const client = createHookDbClient(dbPath);
      database = client.db;
      ownedDb = true;
    }

    database.prepare(`
      INSERT INTO hook_telemetry (hook_name, event_type, duration_ms, success, error_message, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      hookName,
      eventType,
      durationMs,
      success ? 1 : 0,
      error ?? null,
      metadata ? JSON.stringify(metadata) : null,
    );

    if (ownedDb) database.close();
  } catch {
    // Telemetry failure must never block hook execution
  }
}
