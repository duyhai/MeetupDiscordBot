/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Logger } from 'tslog';

interface LoggingDecoratorArgs {
  level?: 'info' | 'warn' | 'error';
  logArgs: boolean;
  logResult: boolean;
  name: string;
}

function loggingDecorator({
  name,
  level = 'info',
  logArgs = false,
  logResult = false,
}: LoggingDecoratorArgs) {
  const logger = new Logger({ name });
  let loggerFn = (args: unknown) => logger.info(args);
  if (level === 'warn') {
    loggerFn = (args: unknown) => logger.warn(args);
  }
  if (level === 'error') {
    loggerFn = (args: unknown) => logger.error(args);
  }

  return (
    target: unknown,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) => {
    const targetMethod = descriptor.value;
    return {
      ...descriptor,
      value: (...args: unknown[]) => {
        loggerFn(`Calling ${propertyKey}`);
        if (logArgs) {
          loggerFn(`Arguments: ${JSON.stringify(args)}`);
        }
        let result: unknown;
        if (typeof targetMethod.apply === 'function') {
          result = targetMethod.apply(this, args);
        }
        if (logResult) {
          loggerFn(`Result: ${JSON.stringify(result)}`);
        }
      },
    };
  };
}

export default loggingDecorator;
