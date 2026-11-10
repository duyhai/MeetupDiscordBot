export class WorkspaceDeadlineError extends Error {
  constructor(ms: number) {
    super(`workspace request took over ${ms} ms`);
    this.name = 'WorkspaceDeadlineError';
  }
}

/**
 * fn's answer, or a WorkspaceDeadlineError after `ms`. The timer is unref'd
 * and always cleared. Promise.race subscribes to the work, so a rejection
 * after the deadline is still handled (never an unhandled rejection).
 */
export async function withDeadline<T>(
  ms: number,
  fn: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = fn();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new WorkspaceDeadlineError(ms)), ms);
      timer.unref();
    });
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
