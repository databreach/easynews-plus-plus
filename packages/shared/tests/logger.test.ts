import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Import classes for instanceof checks globally.
// createLogger will be dynamically imported in each test.
import {
  ClientLogger,
  CloudflareLogger,
  SummaryLogger,
  // Logger as InternalLoggerInterface, // Not directly used for instanceof in new tests
} from '../src/logger';

// Mock fetch globally for Discord tests
global.fetch = vi.fn();

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

// --- Discord Integration Tests ---
describe('Logger with Discord Integration', () => {
  let originalProcessEnv: NodeJS.ProcessEnv;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;
  let createLoggerModule: typeof import('../src/logger');

  beforeEach(async () => {
    // Backup and clear process.env
    originalProcessEnv = { ...process.env };
    // Clear specific Discord vars, but keep others from originalEnv for realistic testing
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_BOT_NAME;
    delete process.env.DISCORD_BOT_AVATAR;
    delete process.env.DISCORD_LOG_LEVEL;

    // Reset mocks
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();

    // Mock console.error specifically for this suite
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Dynamically import createLogger to get a fresh version with current process.env
    vi.resetModules(); // Important to re-evaluate logger module with new env
    createLoggerModule = await import('../src/logger');
  });

  afterEach(() => {
    // Restore process.env
    process.env = originalProcessEnv;
    // Restore mocks
    mockConsoleError.mockRestore();
    vi.resetAllMocks(); // Clean up any other global mocks if necessary, or be more specific
  });

  it('should not send to Discord if DISCORD_WEBHOOK_URL is not set', async () => {
    process.env.DISCORD_WEBHOOK_URL = ''; // Explicitly empty
    const logger = createLoggerModule.createLogger({ level: 'info' });
    logger.error('Test error');
    await new Promise(process.nextTick);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should not send to Discord if DISCORD_WEBHOOK_URL is undefined', async () => {
    // DISCORD_WEBHOOK_URL is already undefined due to beforeEach
    const logger = createLoggerModule.createLogger({ level: 'info' });
    logger.error('Test error');
    await new Promise(process.nextTick);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should send to Discord if webhook URL is set and log level matches (default ERROR for Discord)', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test/default';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, text: async () => '' });

    const logger = createLoggerModule.createLogger({ level: 'info' }); // Winston level
    logger.error('Test error for Discord');
    await new Promise(process.nextTick);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/test/default',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '[ERROR] Test error for Discord' }),
      })
    );
  });

  it('should respect DISCORD_LOG_LEVEL (e.g., INFO)', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test/info_level';
    process.env.DISCORD_LOG_LEVEL = 'INFO';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: async () => '' }); // Mock for all calls

    const logger = createLoggerModule.createLogger({ level: 'debug' }); // Winston log level
    logger.debug('This is a debug message.'); // Should not be sent
    logger.info('This is an info message.'); // Should be sent
    logger.warn('This is a warning message.'); // Should be sent
    logger.error('This is an error message.'); // Should be sent

    await new Promise(process.nextTick);
    await new Promise(process.nextTick); // Extra ticks if multiple async logs are tightly packed
    await new Promise(process.nextTick);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ content: '[INFO] This is an info message.' }),
      })
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ content: '[WARN] This is a warning message.' }),
      })
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ content: '[ERROR] This is an error message.' }),
      })
    );
  });

  it('should not send messages below DISCORD_LOG_LEVEL (e.g. WARN)', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test/warn_level';
    process.env.DISCORD_LOG_LEVEL = 'WARN';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: async () => '' });

    const logger = createLoggerModule.createLogger({ level: 'debug' });
    logger.info('This info should not be sent.');
    logger.debug('This debug should not be sent.');
    await new Promise(process.nextTick);
    expect(fetch).not.toHaveBeenCalled();

    logger.warn('This warning should be sent.');
    await new Promise(process.nextTick);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ content: '[WARN] This warning should be sent.' }),
      })
    );
  });

  it('should use customEnv for Cloudflare-like environment and take precedence over process.env', async () => {
    const customEnv = {
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/custom/custom',
      DISCORD_LOG_LEVEL: 'WARN',
      DISCORD_BOT_NAME: 'CustomBot',
      DISCORD_BOT_AVATAR: 'http://custom.avatar.com/img.png',
    };
    // Set process.env values to ensure customEnv takes precedence
    process.env.DISCORD_WEBHOOK_URL = 'http://global.webhook.com/ignored';
    process.env.DISCORD_LOG_LEVEL = 'ERROR'; // customEnv is WARN
    process.env.DISCORD_BOT_NAME = 'GlobalBotIgnored';

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, text: async () => '' });

    // Logger's own level must be permissive enough for 'WARN' to be logged by the base logger
    const logger = createLoggerModule.createLogger({
      level: 'info',
      customEnv,
      isCloudflare: true,
    });

    logger.info('This info should not be sent to Discord by customEnv (WARN)');
    await new Promise(process.nextTick);
    expect(fetch).not.toHaveBeenCalled();

    logger.warn('Warning from custom env');
    await new Promise(process.nextTick);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/custom/custom',
      expect.objectContaining({
        body: JSON.stringify({
          content: '[WARN] Warning from custom env',
          username: 'CustomBot',
          avatar_url: 'http://custom.avatar.com/img.png',
        }),
      })
    );
  });

  it('should include bot name and avatar if set in process.env (Node.js logger)', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test/bot_details';
    process.env.DISCORD_LOG_LEVEL = 'INFO'; // Discord log level
    process.env.DISCORD_BOT_NAME = 'TestBotNode';
    process.env.DISCORD_BOT_AVATAR = 'http://example.com/avatar_node.png';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, text: async () => '' });

    // createLogger by default (no isCloudflare) creates a Winston-based logger for Node.js
    const logger = createLoggerModule.createLogger({ level: 'info' }); // Winston log level
    logger.info('Test with bot details from process.env');

    await new Promise(process.nextTick);

    expect(fetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/test/bot_details',
      expect.objectContaining({
        body: JSON.stringify({
          content: '[INFO] Test with bot details from process.env',
          username: 'TestBotNode',
          avatar_url: 'http://example.com/avatar_node.png',
        }),
      })
    );
  });

  it('should log to console.error if fetch fails (response not ok)', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test/fetch_fail';
    process.env.DISCORD_LOG_LEVEL = 'ERROR';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => 'Discord error body content',
    });

    const logger = createLoggerModule.createLogger({ level: 'info' });
    logger.error('Error message that will fail to send');

    await new Promise(process.nextTick);

    expect(mockConsoleError).toHaveBeenCalledWith(
      '[Logger] Failed to send log to Discord: 500 Server Error',
      'Discord error body content'
    );
  });

  it('should log to console.error if fetch itself throws an error', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test/fetch_throw';
    process.env.DISCORD_LOG_LEVEL = 'WARN';
    const fetchError = new Error('Network connection failed');
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(fetchError);

    const logger = createLoggerModule.createLogger({ level: 'info' });
    logger.warn('A warning that will fail to send due to network error');

    await new Promise(process.nextTick);

    expect(mockConsoleError).toHaveBeenCalledWith(
      '[Logger] Error sending log to Discord:',
      fetchError
    );
  });

  it('should handle invalid DISCORD_LOG_LEVEL by defaulting to ERROR and logging a console error', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test/invalid_level';
    process.env.DISCORD_LOG_LEVEL = 'INVALID_LEVEL_XYZ'; // Invalid level
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: async () => '' });

    const logger = createLoggerModule.createLogger({ level: 'debug' });

    // First call (e.g., logger.info)
    logger.info('Info message - should not be sent due to invalid level defaulting to ERROR');
    await new Promise(process.nextTick);
    expect(fetch).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalledTimes(1); // Called once so far
    expect(mockConsoleError).toHaveBeenNthCalledWith(
      1,
      '[Logger] Invalid DISCORD_LOG_LEVEL: "INVALID_LEVEL_XYZ". Defaulting to ERROR for filtering.'
    );

    // Second call (e.g., logger.error)
    logger.error('Error message - should be sent as default is ERROR');
    await new Promise(process.nextTick);
    expect(fetch).toHaveBeenCalledTimes(1); // Fetch is called for this one
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          content: '[ERROR] Error message - should be sent as default is ERROR',
        }),
      })
    );
    expect(mockConsoleError).toHaveBeenCalledTimes(2); // Called a second time
    expect(mockConsoleError).toHaveBeenNthCalledWith(
      2,
      '[Logger] Invalid DISCORD_LOG_LEVEL: "INVALID_LEVEL_XYZ". Defaulting to ERROR for filtering.'
    );
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
