import { createHash } from 'node:crypto';

/**
 * Deterministic project ID from a filesystem path.
 * Format: "<dirname>-<8-char-sha256>"
 * Example: /opt/odoo/custom-addons → "custom-addons-c42a21ca"
 */
export function projectId(dirPath: string): string {
  const name = dirPath.split('/').filter(Boolean).pop() ?? 'unknown';
  const hash = createHash('sha256').update(dirPath).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}
