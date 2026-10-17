import { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ logged: [] as string[] }));

vi.mock('tslog', () => {
  class Logger {
    debug = (...args: unknown[]) =>
      fake.logged.push(args.map(String).join(' '));

    info = (...args: unknown[]) => fake.logged.push(args.map(String).join(' '));

    warn = (...args: unknown[]) => fake.logged.push(args.map(String).join(' '));

    error = (...args: unknown[]) =>
      fake.logged.push(args.map(String).join(' '));
  }
  return { Logger };
});

const { appErrorHandler } = await import('../src/app.js');

function fakeResponse(headersSent: boolean) {
  const res = {
    headersSent,
    destroy: vi.fn(),
    status: vi.fn(() => res),
    send: vi.fn(() => res),
  };
  return res;
}

describe('appErrorHandler', () => {
  it('renders the branded 500 page before the response starts', () => {
    const res = fakeResponse(false);
    appErrorHandler(
      new Error('boom'),
      {} as Request,
      res as unknown as Response,
      vi.fn() as NextFunction,
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it('destroys the socket instead of rendering once headers are out', () => {
    fake.logged.length = 0;
    const res = fakeResponse(true);
    appErrorHandler(
      new Error('mid-stream'),
      {} as Request,
      res as unknown as Response,
      vi.fn() as NextFunction,
    );
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
    expect(
      fake.logged.filter((l) =>
        l.startsWith('Unhandled route error after the response started'),
      ),
    ).toHaveLength(1);
  });
});
