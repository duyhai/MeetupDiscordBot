/* eslint-disable no-await-in-loop */
import { sleep } from './sleep';

interface TimeoutOptions {
  intervalMs: number;
  message: string;
  timeoutMs: number;
}

export async function spinWait<TResult>(
  fn: () => Promise<TResult>,
  { timeoutMs = 5000, message = 'Timeout', intervalMs = 100 }: TimeoutOptions,
) {
  const startTime = Date.now();

  let result = await fn();
  while (!result) {
    await sleep(intervalMs);
    const elapsedTimeMs = Date.now() - startTime;
    if (timeoutMs <= elapsedTimeMs) {
      throw new Error(message);
    }
    result = await fn();
  }
  return result;
}
