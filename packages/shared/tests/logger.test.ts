import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Import classes for instanceof checks globally.
// createLogger will be dynamically imported in each test.
import {
  ClientLogger,
  CloudflareLogger,
  SummaryLogger,
  Logger as InternalLoggerInterface,
} from '../src/logger';

const mockWinstonInstance = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  silly: vi.fn(),
  level: 'info',
  shouldLog: vi.fn(() => true),
  on: vi.fn(),
  configure: vi.fn(),
};

describe('createLogger Factory', () => {
  const originalEnv = { ...process.env };
  let originalWindow: typeof globalThis.window | undefined;
  let originalCaches: typeof globalThis.caches | undefined;

  beforeEach(async () => {
    process.env = { ...originalEnv };

    originalWindow = globalThis.window;
    originalCaches = globalThis.caches;

    // @ts-ignore
    if (typeof globalThis.window !== 'undefined') delete globalThis.window;
    // @ts-ignore
    if (typeof globalThis.caches !== 'undefined') delete globalThis.caches;

    mockWinstonInstance.error.mockClear();
    mockWinstonInstance.warn.mockClear();
    mockWinstonInstance.info.mockClear();
    mockWinstonInstance.debug.mockClear();
    mockWinstonInstance.silly.mockClear();
    mockWinstonInstance.level = 'info';
    mockWinstonInstance.on.mockClear();
    mockWinstonInstance.configure.mockClear();
    mockWinstonInstance.shouldLog.mockClear().mockReturnValue(true);

    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should return ClientLogger in client environment (window defined)', async () => {
    vi.stubGlobal('window', {});
    const { createLogger, ClientLogger: DynamicallyImportedClientLogger } = await import(
      '../src/logger'
    );
    const logger = createLogger();
    expect(logger).toBeInstanceOf(DynamicallyImportedClientLogger);
    expect(logger.level).toBe('info');
  });

  it('should return ClientLogger with specified level', async () => {
    vi.stubGlobal('window', {});
    const { createLogger, ClientLogger: DynamicallyImportedClientLogger } = await import(
      '../src/logger'
    );
    const logger = createLogger({ level: 'debug' });
    expect(logger).toBeInstanceOf(DynamicallyImportedClientLogger);
    expect(logger.level).toBe('debug');
  });

  it('should return CloudflareLogger if globalThis.caches is defined (Cloudflare Worker)', async () => {
    vi.stubGlobal('caches', {});
    const actualWinston = (await vi.importActual('winston')) as any;
    const winstonSpy = vi.spyOn(actualWinston.default, 'createLogger');

    const {
      createLogger,
      CloudflareLogger: DynamicallyImportedCloudflareLogger,
      SummaryLogger: DynamicallyImportedSummaryLogger,
    } = await import('../src/logger');
    const logger = createLogger();

    expect(logger).toBeInstanceOf(DynamicallyImportedCloudflareLogger);
    expect(logger).not.toBeInstanceOf(DynamicallyImportedSummaryLogger);
    expect((logger as CloudflareLogger).moduleName).toBe('general');
    expect(logger.level).toBe('info');
    expect(winstonSpy).not.toHaveBeenCalled();
  });

  it('should return CloudflareLogger if process.env.CLOUDFLARE is "true"', async () => {
    process.env.CLOUDFLARE = 'true';
    const actualWinston = (await vi.importActual('winston')) as any;
    const winstonSpy = vi.spyOn(actualWinston.default, 'createLogger');

    const {
      createLogger,
      CloudflareLogger: DynamicallyImportedCloudflareLogger,
      SummaryLogger: DynamicallyImportedSummaryLogger,
    } = await import('../src/logger');
    const logger = createLogger();

    expect(logger).toBeInstanceOf(DynamicallyImportedCloudflareLogger);
    expect(logger).not.toBeInstanceOf(DynamicallyImportedSummaryLogger);
    expect((logger as CloudflareLogger).moduleName).toBe('general');
    expect(logger.level).toBe('info');
    expect(winstonSpy).not.toHaveBeenCalled();
  });

  it('should return SummaryLogger wrapping Winston in Node.js by default', async () => {
    delete process.env.CLOUDFLARE;

    const actualWinston = (await vi.importActual('winston')) as any;
    const winstonSpy = vi
      .spyOn(actualWinston.default, 'createLogger')
      .mockReturnValue(mockWinstonInstance);

    const { createLogger, SummaryLogger: DynamicallyImportedSummaryLogger } = await import(
      '../src/logger'
    );
    const logger = createLogger();

    expect(logger).toBeInstanceOf(DynamicallyImportedSummaryLogger);
    expect(winstonSpy).toHaveBeenCalledTimes(2); // Module-level + test call
    const summaryLogger = logger as SummaryLogger;
    // @ts-ignore
    expect(summaryLogger.logger).toBe(mockWinstonInstance);
    expect(summaryLogger.level).toBe('info');
  });

  it('should use EASYNEWS_LOG_LEVEL for Node.js logger', async () => {
    process.env.EASYNEWS_LOG_LEVEL = 'debug';
    delete process.env.CLOUDFLARE;

    const actualWinston = (await vi.importActual('winston')) as any;
    const winstonSpy = vi
      .spyOn(actualWinston.default, 'createLogger')
      .mockImplementation((options?: any) => {
        if (options && options.level) {
          mockWinstonInstance.level = options.level;
        }
        return mockWinstonInstance;
      });

    const { createLogger } = await import('../src/logger');
    const logger = createLogger();

    expect(winstonSpy).toHaveBeenCalledTimes(2);
    const winstonOptions = winstonSpy.mock.calls[1][0]; // Check the second call for test-specific options
    expect(winstonOptions.level).toBe('debug');
    expect(mockWinstonInstance.level).toBe('debug');
    expect(logger.level).toBe('debug');
  });

  it('should disable SummaryLogger if EASYNEWS_SUMMARIZE_LOGS is false for Node.js logger', async () => {
    process.env.EASYNEWS_SUMMARIZE_LOGS = 'false';
    delete process.env.CLOUDFLARE;

    const actualWinston = (await vi.importActual('winston')) as any;
    const winstonSpy = vi
      .spyOn(actualWinston.default, 'createLogger')
      .mockReturnValue(mockWinstonInstance);

    const { createLogger, SummaryLogger: DynamicallyImportedSummaryLogger } = await import(
      '../src/logger'
    );
    const logger = createLogger();

    expect(logger).not.toBeInstanceOf(DynamicallyImportedSummaryLogger);
    expect(logger).toBe(mockWinstonInstance);
    expect(winstonSpy).toHaveBeenCalledTimes(2);
  });

  it('should prioritize ClientLogger if window is defined, even if CF_ENV is true', async () => {
    vi.stubGlobal('window', {});
    process.env.CLOUDFLARE = 'true';
    const { createLogger, ClientLogger: DynamicallyImportedClientLogger } = await import(
      '../src/logger'
    );
    const logger = createLogger();
    expect(logger).toBeInstanceOf(DynamicallyImportedClientLogger);
  });

  it('should prioritize CloudflareLogger (from globalThis.caches) if both caches and CLOUDFLARE env are set', async () => {
    vi.stubGlobal('caches', {});
    process.env.CLOUDFLARE = 'true';
    const {
      createLogger,
      CloudflareLogger: DynamicallyImportedCloudflareLogger,
      SummaryLogger: DynamicallyImportedSummaryLogger,
    } = await import('../src/logger');
    const logger = createLogger();
    expect(logger).toBeInstanceOf(DynamicallyImportedCloudflareLogger);
    expect(logger).not.toBeInstanceOf(DynamicallyImportedSummaryLogger);
  });

  it('should pass prefix and username to CloudflareLogger', async () => {
    vi.stubGlobal('caches', {});
    const usernameFn = () => 'testuser';
    const { createLogger, CloudflareLogger: DynamicallyImportedCloudflareLogger } = await import(
      '../src/logger'
    );
    const logger = createLogger({ prefix: 'TestPrefix', username: usernameFn });
    expect(logger).toBeInstanceOf(DynamicallyImportedCloudflareLogger);
    const cfLogger = logger as CloudflareLogger;
    expect(cfLogger.moduleName).toBe('TestPrefix');
    expect(cfLogger.username).toBe(usernameFn);
  });

  it('should pass prefix and username to Winston logger via SummaryLogger', async () => {
    const usernameFn = () => 'winstonuser';
    delete process.env.CLOUDFLARE;

    const actualWinston = (await vi.importActual('winston')) as any;
    const winstonSpy = vi
      .spyOn(actualWinston.default, 'createLogger')
      .mockReturnValue(mockWinstonInstance);

    const { createLogger, SummaryLogger: DynamicallyImportedSummaryLogger } = await import(
      '../src/logger'
    );
    const logger = createLogger({ prefix: 'WinstonPrefix', username: usernameFn });

    expect(logger).toBeInstanceOf(DynamicallyImportedSummaryLogger);
    expect(winstonSpy).toHaveBeenCalledTimes(2);

    const winstonOptions = winstonSpy.mock.calls[1][0];
    expect(winstonOptions.format).toBeDefined();
  });
});

describe('SummaryLogger', () => {
  let mockBaseLogger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    silly: ReturnType<typeof vi.fn>;
    level: string;
    shouldLog: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockBaseLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      silly: vi.fn(),
      level: 'debug',
      shouldLog: vi.fn((level: string) => {
        const levels: { [key: string]: number } = {
          error: 0,
          warn: 1,
          info: 2,
          debug: 3,
          silly: 4,
        };
        return levels[level] <= levels[mockBaseLogger.level];
      }),
    };
    vi.useRealTimers();
  });

  it('should inherit level from base logger', () => {
    mockBaseLogger.level = 'info';
    const summaryLogger = new SummaryLogger(mockBaseLogger);
    expect(summaryLogger.level).toBe('info');
  });

  it('should call startSummaryInterval if not in Cloudflare Worker environment and setInterval exists', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    // @ts-ignore
    delete globalThis.caches;
    // @ts-ignore
    delete globalThis.window;
    new SummaryLogger(mockBaseLogger);
    expect(setIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('should NOT call startSummaryInterval if in Cloudflare Worker environment', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    vi.stubGlobal('caches', {});
    new SummaryLogger(mockBaseLogger);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('should pass through info, warn, error, silly calls to base logger', () => {
    const summaryLogger = new SummaryLogger(mockBaseLogger);
    summaryLogger.info('Info message', { data: 1 });
    expect(mockBaseLogger.info).toHaveBeenCalledWith('Info message', { data: 1 });
    summaryLogger.warn('Warn message', 'arg2');
    expect(mockBaseLogger.warn).toHaveBeenCalledWith('Warn message', 'arg2');
    summaryLogger.error('Error message', new Error('test err'));
    expect(mockBaseLogger.error).toHaveBeenCalledWith('Error message', new Error('test err'));
    summaryLogger.silly('Silly message');
    expect(mockBaseLogger.silly).toHaveBeenCalledWith('Silly message');
  });

  describe('Debug Summarization', () => {
    it('should log first instance of a patterned debug message and summarize subsequent ones matching the same pattern', () => {
      const summaryLogger = new SummaryLogger(mockBaseLogger);
      const patternedMessage1 = '[EasynewsAPI] Cache miss for key: testKey123...';
      const patternedMessage2 = '[EasynewsAPI] Cache miss for key: testKey456...';
      summaryLogger.debug(patternedMessage1);
      expect(mockBaseLogger.debug).toHaveBeenCalledWith(patternedMessage1);
      expect(mockBaseLogger.debug).toHaveBeenCalledTimes(1);
      summaryLogger.debug(patternedMessage1);
      expect(mockBaseLogger.debug).toHaveBeenCalledTimes(1);
      summaryLogger.debug(patternedMessage2);
      expect(mockBaseLogger.debug).toHaveBeenCalledTimes(1);
      // @ts-ignore
      summaryLogger.flushLogs();
      expect(mockBaseLogger.debug).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[SUMMARY\] \[EasynewsAPI\] Cache \(hit\|miss\|expired\) {2}>> miss: 3 similar logs/
        )
      );
      expect(mockBaseLogger.debug).toHaveBeenCalledTimes(2);
    });

    it('should log first instance of a generic (non-predefined-pattern) debug message and summarize subsequent identical ones', () => {
      const summaryLogger = new SummaryLogger(mockBaseLogger);
      const genericMessage = 'This is a generic debug message with value 123';
      summaryLogger.debug(genericMessage);
      expect(mockBaseLogger.debug).toHaveBeenCalledWith(genericMessage);
      expect(mockBaseLogger.debug).toHaveBeenCalledTimes(1);
      summaryLogger.debug(genericMessage);
      expect(mockBaseLogger.debug).toHaveBeenCalledTimes(1);
      summaryLogger.debug('This is another generic debug message with value 456');
      expect(mockBaseLogger.debug).toHaveBeenCalledWith(
        'This is another generic debug message with value 456'
      );
      expect(mockBaseLogger.debug).toHaveBeenCalledTimes(2);
    });

    it('should not call base logger debug if level is too low', () => {
      mockBaseLogger.level = 'info';
      const summaryLogger = new SummaryLogger(mockBaseLogger);
      summaryLogger.debug('A debug message');
      expect(mockBaseLogger.debug).not.toHaveBeenCalled();
    });
  });

  describe('flushLogs', () => {
    it('should log summary messages when flushLogs is called', () => {
      const summaryLogger = new SummaryLogger(mockBaseLogger);
      const patternedMessage = '[EasynewsAPI] Cache miss for key: flushTestKey...';
      summaryLogger.debug(patternedMessage);
      summaryLogger.debug(patternedMessage);
      summaryLogger.debug(patternedMessage);
      expect(mockBaseLogger.debug).toHaveBeenCalledTimes(1);
      // @ts-ignore
      summaryLogger.flushLogs();
      expect(mockBaseLogger.debug).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[SUMMARY\] \[EasynewsAPI\] Cache \(hit\|miss\|expired\) {2}>> miss: 3 similar logs/
        )
      );
      expect(mockBaseLogger.debug).toHaveBeenCalledTimes(2);
      // @ts-ignore
      expect(summaryLogger.messageCounters.size).toBe(0);
    });

    it('should not log summary if count is 1 when flushLogs is called', () => {
      const summaryLogger = new SummaryLogger(mockBaseLogger);
      const patternedMessage = '[EasynewsAPI] Cache hit for key: singleFlush...';
      summaryLogger.debug(patternedMessage);
      expect(mockBaseLogger.debug).toHaveBeenCalledTimes(1);
      // @ts-ignore
      summaryLogger.flushLogs();
      expect(mockBaseLogger.debug).toHaveBeenCalledTimes(1);
    });
  });
});

// --- ClientLogger Tests ---
// ClientLogger is imported at the top for direct instantiation.
describe('ClientLogger', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('Constructor', () => {
    it('should set default level to "info" if no level provided', () => {
      const logger = new ClientLogger();
      expect(logger.level).toBe('info');
    });

    it('should set custom level from options', () => {
      const logger = new ClientLogger('debug');
      expect(logger.level).toBe('debug');
    });
  });

  describe('Logging Methods', () => {
    it('should call console.error with prefix for error()', () => {
      const logger = new ClientLogger();
      const errorArg = new Error('test error');
      logger.error('Error message', errorArg, { details: 'more info' });
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith('[Easynews++]', 'Error message', errorArg, {
        details: 'more info',
      });
    });

    it('should call console.warn with prefix for warn()', () => {
      const logger = new ClientLogger();
      logger.warn('Warning message', 123, 'foo');
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledWith('[Easynews++]', 'Warning message', 123, 'foo');
    });

    it('should call console.log with prefix for info()', () => {
      const logger = new ClientLogger();
      logger.info('Info message', { data: 'payload' });
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith('[Easynews++]', 'Info message', {
        data: 'payload',
      });
    });

    it('should call console.log with prefix for debug()', () => {
      const logger = new ClientLogger('debug');
      logger.debug('Debug message', true);
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith('[Easynews++]', 'Debug message', true);
    });

    it('should call console.log with prefix for silly()', () => {
      const logger = new ClientLogger('silly');
      logger.silly('Silly message');
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith('[Easynews++]', 'Silly message');
    });
  });
});
