import { Logger } from 'tslog';
import { ApplicationCache } from '../../util/cache';

const logger = new Logger({ name: 'cachedClientRequest' });

export async function cachedClientRequest<TInput, TResponse>(
  requestName: string,
  datagenCallbackInput: TInput,
  datagenCallbackFn: (callbackInput: TInput) => Promise<TResponse>
): Promise<TResponse> {
  const cacheKey = `${requestName}-${JSON.stringify(datagenCallbackInput)}`;
  const cache = await ApplicationCache();
  const data = await cache.get(cacheKey);
  if (data) {
    logger.info(`Cache hit for ${cacheKey}`);
    return JSON.parse(data) as TResponse;
  }

  logger.info(`Cache miss for ${cacheKey}`);
  const result = await datagenCallbackFn(datagenCallbackInput);
  await cache.set(cacheKey, JSON.stringify(result));
  return result;
}
