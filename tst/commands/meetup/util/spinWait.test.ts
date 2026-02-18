import { spinWait } from '../../../../src/util/spinWait';

describe('spinWait', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return the result if fn resolves to a truthy value immediately', async () => {
    const fn = jest.fn().mockResolvedValue(true);
    const result = await spinWait(fn, {
      timeoutMs: 100,
      intervalMs: 10,
      message: 'Timeout',
    });

    expect(result).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1); // Should only call the function once
  });

  it('should throw an error when timeout is reached', async () => {
    const fn = jest.fn().mockResolvedValue(false); // Always returns falsy value

    await expect(
      spinWait(fn, { timeoutMs: 100, intervalMs: 10, message: 'Timeout' })
    ).rejects.toThrow('Timeout');

    expect(fn).toHaveBeenCalled();
  });

  it('should return the result if fn eventually resolves to a truthy value', async () => {
    const fn = jest
      .fn()
      .mockResolvedValueOnce(false) // Initially returns falsy
      .mockResolvedValueOnce(true); // Returns truthy on second call

    const resultPromise = spinWait(fn, {
      timeoutMs: 100,
      intervalMs: 10,
      message: 'Timeout',
    });

    await expect(resultPromise).resolves.toBe(true);
    expect(fn).toHaveBeenCalledTimes(2); // fn called twice before success
  });
});
