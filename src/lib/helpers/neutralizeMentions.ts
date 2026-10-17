/**
 * For the dashboard's copy text only: a zero-width space (U+200B) after
 * every "@" and after every "<#" and "</", so pasting the post into Discord
 * pings nobody and links nothing. That covers "@everyone", "@here", "<@…>"
 * user, nickname and role mentions, and typed "@Name" or "@RoleName" that
 * the client would turn into a mention, plus channel links and slash
 * command mentions. The fixed text of formatHallOfFamePost has none of
 * these (a test checks), so in effect this touches names and titles only.
 * Idempotent. Not in formatHallOfFamePost: the slash command's output (and
 * its goldens) stay byte-identical.
 */
export function neutralizeMentions(text: string): string {
  return text.replace(/(@|<#|<\/)(?!\u200b)/g, '$1\u200b');
}
