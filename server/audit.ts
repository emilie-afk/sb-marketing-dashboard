import { query } from "./db";

export async function audit(actor: string, action: string, targetType?: string, targetId?: string, details?: unknown) {
  await query("insert into audit_events (actor, action, target_type, target_id, details) values ($1,$2,$3,$4,$5)",
    [actor, action, targetType ?? null, targetId ?? null, details === undefined ? null : JSON.stringify(details)]);
}
