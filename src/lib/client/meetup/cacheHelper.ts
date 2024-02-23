import { Logger } from 'tslog';
import { InMemoryCache } from '../../cache/memoryCache';

const logger = new Logger({ name: 'cachedGqlRequest' });

export async function cachedGqlRequest<TInput, TResponse>(
  requestName: string,
  datagenCallbackInput: TInput,
  datagenCallbackFn: (callbackInput: TInput) => Promise<TResponse>
): Promise<TResponse> {
  const cacheKey = `${requestName}-${JSON.stringify(datagenCallbackInput)}`;
  const data = await InMemoryCache.instance().get(cacheKey);
  if (data) {
    logger.info(`Cache hit for ${cacheKey}`);
    return JSON.parse(data) as TResponse;
  }

  logger.info(`Cache miss for ${cacheKey}`);
  const result = await datagenCallbackFn(datagenCallbackInput);
  await InMemoryCache.instance().set(cacheKey, JSON.stringify(result));
  return result;
}
