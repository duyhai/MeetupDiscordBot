import { describe, expect, it } from 'vitest';
import { neutralizeMentions } from '../../../src/lib/helpers/neutralizeMentions.js';

describe('neutralizeMentions', () => {
  it('inserts U+200B after the @ of each mention form only', () => {
    expect(neutralizeMentions('@everyone @here <@1> <@!2> <@&3>')).toBe(
      '@\u200beveryone @\u200bhere <@\u200b1> <@\u200b!2> <@\u200b&3>',
    );
    expect(neutralizeMentions('@\u200beveryone')).toBe('@\u200beveryone');
  });

  it('defuses every @, <# and </, and is idempotent', () => {
    expect(neutralizeMentions('@Moderator')).toBe('@\u200bModerator');
    expect(neutralizeMentions('#general-ish <#123>')).toBe(
      '#general-ish <#\u200b123>',
    );
    expect(neutralizeMentions('</ping:1>')).toBe('</\u200bping:1>');
    expect(neutralizeMentions('mail me@example.com, @Ann, 3 @ 5')).toBe(
      'mail me@\u200bexample.com, @\u200bAnn, 3 @\u200b 5',
    );
    for (const text of [
      '@everyone @here <@1> <@!2> <@&3>',
      '@Moderator @RoleName #general-ish <#123> </ping:1>',
      'a @@ b <#<# c <//',
    ]) {
      const once = neutralizeMentions(text);
      expect(neutralizeMentions(once), text).toBe(once);
      expect(once, text).not.toMatch(/@(?!\u200b)|<#(?!\u200b)|<\/(?!\u200b)/);
    }
  });
});
