// Scanner behind tst/lib/noPings.test.ts. Nothing this bot posts may ping
// anyone (Hai, 2026-10-16).

export interface PingViolation {
  rule: 'allowedMentions' | 'role mention';
  detail: string;
}

/**
 * Files allowed to build a role mention, each with its reason. Anything else
 * that matches ROLE_MENTION fails the scan.
 */
export const ROLE_MENTION_ALLOW_LIST: Record<string, string> = {
  // The user-triggered "message mods" thread starter deliberately mentions
  // the moderator role and sends with SuppressNotifications. It is outside
  // the no-pings ruling for #meetup-bot-alerts and is unchanged here.
  'src/buttonMenu/messageMods.ts':
    'user-triggered mod thread starter; mentions the moderator role, sent with SuppressNotifications',
};

/**
 * Removes // and block comments while leaving string and template literals
 * intact (a tokenizer, so `//` inside `${base}//x` is not a comment). Regex
 * literals are not tokenized; a quote inside one could throw the scan off,
 * which can only over-report, never hide a mention in code.
 */
export function stripComments(text: string): string {
  let out = '';
  // 'code' | a quote char | '`' for template text. `braces` tracks ${ }.
  const stack: ('brace' | 'template')[] = [];
  let i = 0;
  const peek = (n = 0) => text[i + n];
  while (i < text.length) {
    const c = peek();
    const inTemplate = stack[stack.length - 1] === 'template';
    if (inTemplate) {
      if (c === '\\') {
        out += text.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        stack.pop();
        out += c;
        i += 1;
      } else if (c === '$' && peek(1) === '{') {
        stack.push('brace');
        out += '${';
        i += 2;
      } else {
        out += c;
        i += 1;
      }
    } else if (c === '/' && peek(1) === '/') {
      while (i < text.length && peek() !== '\n') {
        i += 1;
      }
    } else if (c === '/' && peek(1) === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') {
        j += text[j] === '\\' ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '`') {
      stack.push('template');
      out += c;
      i += 1;
    } else if (c === '{' && stack.length > 0) {
      stack.push('brace');
      out += c;
      i += 1;
    } else if (c === '}' && stack[stack.length - 1] === 'brace') {
      stack.pop();
      out += c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

// '<@&' in any string, template or concatenation, or the discord.js helper.
// (role.toString() also renders a mention but cannot be told from other
// toString calls by text alone; messageMods.ts is the one known user.)
const ROLE_MENTION = /<@&|\broleMention\s*\(/;
const ALLOWED_MENTIONS = /\ballowed(?:M|_m)entions\b/g;
const EXACT_NO_PARSE = /^\s*:\s*\{\s*parse\s*:\s*\[\s*\]\s*,?\s*\}/;

export function findPingViolations(
  file: string,
  rawText: string,
): PingViolation[] {
  const text = stripComments(rawText);
  const found: PingViolation[] = [];
  if (ROLE_MENTION.test(text) && !(file in ROLE_MENTION_ALLOW_LIST)) {
    found.push({ rule: 'role mention', detail: file });
  }
  for (const match of text.matchAll(ALLOWED_MENTIONS)) {
    const rest = text.slice(match.index + match[0].length);
    if (!EXACT_NO_PARSE.test(rest)) {
      found.push({
        rule: 'allowedMentions',
        detail: `${file}: ${text.slice(match.index, match.index + 60)}`,
      });
    }
  }
  return found;
}
