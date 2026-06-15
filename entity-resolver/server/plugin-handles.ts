import type { QueryResult, QueryResultRow } from 'pg';
import type { Application } from 'express';

/**
 * Minimal typed handle for the Lakebase plugin exports.
 * Avoids double-assertion by matching the actual plugin export shape.
 */
export interface LakebaseHandle {
  query<T extends QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

/**
 * Minimal typed handle for the Server plugin exports.
 */
export interface ServerHandle {
  extend(fn: (app: Application) => void): void;
}
