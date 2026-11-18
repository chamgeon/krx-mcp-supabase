// Error messages fit for an alert or a stored last_error.
//
// When a service in front of an API fails (Cloudflare in front of Supabase, a proxy in front of KIS), the client gets
// an HTML error page, and supabase-js passes its body on as the error message: a Telegram alert then shows the first
// lines of <!DOCTYPE html>… and nothing useful. The page's <title> says what happened
// ("supabase.co | 520: Web server is returning an unknown error"), so the HTML is replaced with it.

/**
 * `message` with an HTML error page in it replaced by the page's title, and URLs without their query strings (a long
 * query, like KIS's 30 stock codes, would push the cause past a stored error's length limit). Other text is unchanged.
 */
export function readableError(message: string): string {
  message = message.replace(/(https?:\/\/[^\s?"'<>]+)\?[^\s"'<>)]+/g, '$1?…')
  const at = message.search(/<!DOCTYPE html|<html[\s>]/i)
  if (at < 0) return message
  const title = message.slice(at).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const what = title ? title.replace(/\s+/g, ' ').trim() : 'no title'
  return `${message.slice(0, at)}HTML error page (${what})`.trim()
}
