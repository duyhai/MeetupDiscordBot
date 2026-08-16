import { Logger } from 'tslog';
import { ApplicationCache } from '../../util/cache.js';

// A badge computation fans out over every past event and every RSVP of each,
// so an info line per cache hit floods the log: 393 of the 400 lines Heroku
// retained during one onboarding were cache hits, which pushed the evidence
// of an actual failure out of the buffer within minutes. Hits are demoted to
// debug and suppressed by default; set LOG_LEVEL=DEBUG to get them back.
// Exported so tests can attach a transport and prove hits are suppressed.
export const cacheLogger = new Logger({
  name: 'cachedClientRequest',
  minLevel: process.env.LOG_LEVEL === 'DEBUG' ? 2 : 3,
});

export async function cachedClientRequest<TInput, TResponse>(
  requestName: string,
  datagenCallbackInput: TInput,
  datagenCallbackFn: (callbackInput: TInput) => Promise<TResponse>,
): Promise<TResponse> {
  const cacheKey = `${requestName}-${JSON.stringify(datagenCallbackInput)}`;
  const cache = await ApplicationCache();
  const data = await cache.get(cacheKey);
  if (data) {
    cacheLogger.debug(`Cache hit for ${cacheKey}`);
    return JSON.parse(data) as TResponse;
  }

  // Misses stay at info: they are the rare, interesting case (a real upstream
  // call) and are what you want when reconstructing what the bot fetched.
  cacheLogger.info(`Cache miss for ${requestName}`);
  const result = await datagenCallbackFn(datagenCallbackInput);
  await cache.set(cacheKey, JSON.stringify(result));
  return result;
}
