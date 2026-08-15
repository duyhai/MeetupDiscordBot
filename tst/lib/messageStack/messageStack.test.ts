import { describe, expect, it } from 'vitest';

import { MessageStack } from '../../../src/lib/messageStack/messageStack.js';

describe('MessageStack', () => {
  it('renders undefined while empty', () => {
    expect(new MessageStack().render()).toBeUndefined();
  });

  it('joins entry content in insertion order', () => {
    const stack = new MessageStack();
    stack.append({ content: 'first' });
    stack.append({ content: 'second' });

    expect(stack.render()?.content).toBe('first\nsecond');
  });

  it('updates an entry in place without reordering', () => {
    const stack = new MessageStack();
    const id = stack.append({ content: 'first' });
    stack.append({ content: 'second' });
    stack.update(id, { content: 'first (updated)' });

    expect(stack.render()?.content).toBe('first (updated)\nsecond');
  });

  it('ignores an update to an unknown id', () => {
    const stack = new MessageStack();
    stack.append({ content: 'only' });
    stack.update('e99', { content: 'ghost' });

    expect(stack.render()?.content).toBe('only');
  });

  it('pop drops the newest entry and is a no-op when empty', () => {
    const stack = new MessageStack();
    stack.append({ content: 'first' });
    stack.append({ content: 'second' });
    stack.pop();

    expect(stack.render()?.content).toBe('first');

    stack.pop();
    expect(stack.render()).toBeUndefined();
    expect(() => stack.pop()).not.toThrow();
  });

  it('concatenates embeds and components in stack order', () => {
    const stack = new MessageStack<string, string>();
    stack.append({ embeds: ['a'], components: ['x'] });
    stack.append({ embeds: ['b'], components: ['y'] });

    expect(stack.render()?.embeds).toEqual(['a', 'b']);
    expect(stack.render()?.components).toEqual(['x', 'y']);
  });

  it('never puts entry text anywhere but content (mentions must ping)', () => {
    const stack = new MessageStack();
    stack.append({ content: 'Welcome <@123>!' });

    const rendered = stack.render();
    expect(rendered?.content).toContain('<@123>');
    expect(rendered?.embeds).toEqual([]);
  });
});

describe('status severity', () => {
  it('is undefined when no entry declares a status', () => {
    const stack = new MessageStack();
    stack.append({ content: 'plain' });

    expect(stack.render()?.status).toBeUndefined();
  });

  it.each([
    [['success'], 'success'],
    [['pending'], 'pending'],
    [['error'], 'error'],
    [['attention'], 'attention'],
    [['pending', 'error'], 'error'],
    [['pending', 'attention'], 'attention'],
    [['success', 'pending'], 'pending'],
    [['success', 'attention', 'error'], 'error'],
  ] as const)('reduces %j to %s', (statuses, expected) => {
    const stack = new MessageStack();
    statuses.forEach((status: (typeof statuses)[number]) =>
      stack.append({ content: 'x', status }),
    );

    expect(stack.render()?.status).toBe(expected);
  });
});
