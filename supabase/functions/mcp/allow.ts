// Who may use this deployment, beyond a valid login: an allowlist of accounts (ALLOWED_USERS secret). The deployment
// is for its operator and a small closed group, so a Google account that can sign in isn't enough on its own.

/** ALLOWED_USERS ("<user id>, <email>, …") as a set; empty when unset, which lets nobody in. */
export function parseAllowed(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
}

/** Whether a verified user is on the list, by Supabase user id or by email (either works; ids never change). */
export function isAllowed(allowed: Set<string>, sub: string, email: unknown): boolean {
  return allowed.has(sub.toLowerCase()) || (typeof email === 'string' && allowed.has(email.toLowerCase()))
}
