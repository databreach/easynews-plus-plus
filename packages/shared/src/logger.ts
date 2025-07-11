// Defer winston import so the module is pulled in **only** when required.
let winston: typeof import('winston') | undefined;

// Add this function somewhere in the file, e.g., before the logger class or as a private method if refactoring to a class.
async function sendToDiscord(
  message: string,
  level: string,
  customEnv?: Record<string, any>
): Promise<void> {
  const env = customEnv || (typeof process !== 'undefined' ? process.env : {}); // Allow passing custom env for CF workers
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  const botName = env.DISCORD_BOT_NAME;
  const botAvatar = env.DISCORD_BOT_AVATAR;
  let discordLogLevelSetting = env.DISCORD_LOG_LEVEL || 'ERROR'; // Default to ERROR

  if (!webhookUrl) {
    return; // Do nothing if webhook URL is not set
  }

  // Map string log levels to numerical severity
  const levelSeverity: { [key: string]: number } = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    SILLY: -1, // SILLY is less important than DEBUG for Discord
  };

  let configuredLevelSeverity = levelSeverity[discordLogLevelSetting.toUpperCase()];

  // If the configured DISCORD_LOG_LEVEL is invalid, log an error and default to 'ERROR' for filtering.
  if (configuredLevelSeverity === undefined) {
    console.error(
      `[Logger] Invalid DISCORD_LOG_LEVEL: "${discordLogLevelSetting}". Defaulting to ERROR for filtering.`
    );
    discordLogLevelSetting = 'ERROR'; // Force to 'ERROR'
    configuredLevelSeverity = levelSeverity[discordLogLevelSetting.toUpperCase()]; // Re-lookup, will now be valid
  }

  // Now check the current message's actual log level.
  const currentLevelSeverity = levelSeverity[level.toUpperCase()];
  // If the level of the message itself (e.g., logger.customLevel('message')) is invalid, don't send.
  if (currentLevelSeverity === undefined) {
    console.error(
      `[Logger] Invalid log level used in logger call: "${level}". Cannot send to Discord.`
    );
    return;
  }

  // Filter based on severity.
  if (currentLevelSeverity < configuredLevelSeverity) {
    return; // Do not send if message level is below configured (potentially defaulted) level
  }

  const payload: { content: string; username?: string; avatar_url?: string } = {
    content: `[${level.toUpperCase()}] ${message}`,
  };

  if (botName) {
    payload.username = botName;
  }
  if (botAvatar) {
    payload.avatar_url = botAvatar;
  }

  try {
    // Use global fetch if available (Node 18+, CF Workers, Browser)
    const fetchFn = typeof fetch !== 'undefined' ? fetch : undefined;

    if (!fetchFn) {
      console.error('[Logger] Global fetch is not available. Cannot send log to Discord.');
      return;
    }

    const response = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // Use response.text() in a separate await to ensure it's processed
      const responseBody = await response.text();
      console.error(
        `[Logger] Failed to send log to Discord: ${response.status} ${response.statusText}`,
        responseBody
      );
    }
  } catch (error) {
    console.error('[Logger] Error sending log to Discord:', error);
  }
}

/**
 * Get the addon version from package.json
 * @returns Version string
 */
export function getVersion(): string {
  try {
    // Try to find the package.json in the project root
    let version;
    try {
      version = require('../../../package.json').version;
    } catch (e) {
      // Fallback - use the closest package.json
      version = require('../package.json').version;
    }
    return version;
  } catch (error) {
    return 'unknown-version';
  }
}

/**
 * Simple logger implementation for Cloudflare environment
 */
export class CloudflareLogger {
  level: string;
  username?: string | (() => string | undefined);
  moduleName: string;
  customEnv?: Record<string, any>; // For CFW

  constructor(
    level: string = 'info',
    username?: string | (() => string | undefined),
    moduleName?: string,
    customEnv?: Record<string, any> // For CFW
  ) {
    this.level = level.toLowerCase();
    this.username = username;
    this.moduleName = moduleName || 'general';
    this.customEnv = customEnv; // Store customEnv
  }

  public shouldLog(level: string): boolean {
    const levels = { error: 0, warn: 1, info: 2, debug: 3, silly: 4 };
    return (
      levels[level as keyof typeof levels] <= levels[this.level as keyof typeof levels] || false
    );
  }

  private formatMessage(
    level: string,
    message: string,
    usernameOpt?: string | (() => string | undefined),
    ...args: any[]
  ): string {
    let user = 'system'; // Default username
    if (usernameOpt) {
      const actualUsername = typeof usernameOpt === 'function' ? usernameOpt() : usernameOpt;
      if (actualUsername) {
        user = actualUsername;
      }
    }
    // The opts.prefix is not used by CloudflareLogger, which is fine. // This comment is no longer accurate
    let formattedMessage = `${level.toUpperCase()} [v${getVersion()}][${this.moduleName}][${user}]: ${message}`;

    if (args.length > 0) {
      const formattedArgs = args
        .map(arg => (typeof arg === 'object' ? JSON.stringify(arg) : arg))
        .join(' ');
      formattedMessage = `${formattedMessage} ${formattedArgs}`;
    }

    return formattedMessage;
  }

  error(message: string, ...args: any[]): void {
    if (this.shouldLog('error')) {
      const formattedMessage = this.formatMessage('error', message, this.username, ...args);
      console.error(formattedMessage);
      sendToDiscord(message, 'ERROR', this.customEnv).catch(console.error);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.shouldLog('warn')) {
      const formattedMessage = this.formatMessage('warn', message, this.username, ...args);
      console.warn(formattedMessage);
      sendToDiscord(message, 'WARN', this.customEnv).catch(console.error);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.shouldLog('info')) {
      const formattedMessage = this.formatMessage('info', message, this.username, ...args);
      console.log(formattedMessage);
      sendToDiscord(message, 'INFO', this.customEnv).catch(console.error);
    }
  }

  debug(message: string, ...args: any[]): void {
    if (this.shouldLog('debug')) {
      const formattedMessage = this.formatMessage('debug', message, this.username, ...args);
      console.log(formattedMessage);
      sendToDiscord(message, 'DEBUG', this.customEnv).catch(console.error);
    }
  }

  silly(message: string, ...args: any[]): void {
    if (this.shouldLog('silly')) {
      const formattedMessage = this.formatMessage('silly', message, this.username, ...args);
      console.log(formattedMessage);
      sendToDiscord(message, 'SILLY', this.customEnv).catch(console.error);
    }
  }
}

/**
 * Logger that summarizes similar debug messages to reduce log volume
 */
export class SummaryLogger {
  private logger: any;
  private messageCounters: Map<string, number> = new Map();
  private messagePatterns: RegExp[] = [
    // Qualitätsprüfungen
    /Checking if video is bad: "([^"]+)"/,
    /Bad video: "([^"]+)": (.+)/,
    /Video passed quality checks: "([^"]+)"/,

    // Titel-Verarbeitung
    /Sanitizing title: "([^"]+)"/,
    /Sanitized result: "([^"]+)"/,

    // Titel-Matching
    /Matching title: "([^"]+)" against query: "([^"]+)"/,
    /Strict mode - (.+)/,
    /Non-strict mode - (.+)/,
    /Main query part: "([^"]+)"/,

    // Stream-Erstellung
    /Creating stream URL with farm: (.+), port: (.+)/,
    /Created stream path: (.+)/,
    /Stream URL created: (.+)/,

    // Qualitätsbestimmung
    /Getting quality for: "([^"]+)"/,
    /Quality found by (.+): (.+)/,
    /Using fallback quality: (.+)/,
    /No quality found/,

    // Suche und Ergebnisse
    /Found (\d+) results for "([^"]+)"/,
    /Example result: "([^"]+)"/,
    /Rejected (.+) by title matching: "([^"]+)"/,
    /Total unique results so far: (\d+)/,
    /Adding (\d+) additional titles from partial matches/,
    /Will search for (\d+) titles:/,
    /Found (\d+) alternative titles for "([^"]+)"/,
    /No alternative titles found for "([^"]+)"/,
    /Final search query: (.+)/,
    /Building search query for (.+): (.+)/,

    // Alternative Titel
    /Getting alternative titles for: "([^"]+)"/,
    /Found partial match between "([^"]+)" and "([^"]+)"/,
    /Found direct match in custom titles for: "([^"]+)"/,
    /Cache key: (.+)/,

    // HTTP-Anfragen und Server
    /Received ([A-Z]+) request for: (.+)/,
    /Starting server on port: (\d+)/,
    /Server started successfully on port: (\d+)/,
    /Creating Express server with options:/,
    /Stremio Router middleware attached/,
    /Handling root request with query params:/,
    /Setting cache max age to: (.+)/,

    // Filterung und Sortierung
    /After quality filtering: (\d+) streams remain/,
    /After max file size filtering: (\d+) streams remain/,
    /Quality ([^:]+): (\d+) streams/,
    /Starting filters with (\d+) streams/,
    /Filtering for qualities: (.+)/,
    /Applying language-first sorting for language: (.+)/,
    /Global stream limit: (\d+)/,
    /Reached global limit of (\d+) streams/,

    // Stream-Mapping
    /Mapping stream: "([^"]+)"/,
    /Stream "([^"]+)" has languages: (.+)/,
    /Stream "([^"]+)" has no language information/,

    // API Patterns
    /\[EasynewsAPI\] Cache (hit|miss|expired) for key: (.+)/,
    /\[EasynewsAPI\] Caching (\d+) results for key: (.+)/,
    /\[EasynewsAPI\] Searching for: "([^"]+)"/,
    /\[EasynewsAPI\] Request URL: (.+)/,
    /\[EasynewsAPI\] Search (request timed out|failed|complete) for: "([^"]+)"/,
    /\[EasynewsAPI\] Starting searchAll for: "([^"]+)"/,
    /\[EasynewsAPI\] Progress: (\d+)\/(\d+) results/,
    /\[EasynewsAPI\] Adding (\d+) results from page (\d+)/,
    /\[EasynewsAPI\] (No more results|Duplicate results|Reached result limit)/,

    // Cloudflare Worker Patterns
    /\[CF\] Initializing Cloudflare Worker/,
    /\[CF\] Generated (default|localized) HTML/,
    /\[CF\] Created Stremio router/,
    /\[CF\] Received (configure|root) request/,
    /\[CF\] Creating (manifest|customized manifest) for language/,
    /\[CF\] Setting language in manifest/,
    /\[CF\] Redirecting to/,
  ];
  private summaryInterval: ReturnType<typeof setInterval> | null = null;
  private flushDelay: number = 1000; // 1 Sekunde Verzögerung
  level: string;

  constructor(logger: any) {
    this.logger = logger;
    this.level = (logger as any).level || 'info';

    // Don't start interval in Cloudflare Worker environment
    const isCloudflareWorker = typeof globalThis.caches !== 'undefined';
    if (!isCloudflareWorker) {
      this.startSummaryInterval();
    }
  }

  private startSummaryInterval() {
    // Intervall nur starten, wenn wir nicht in einem Browser sind
    if (typeof window === 'undefined' && typeof setInterval === 'function') {
      this.summaryInterval = setInterval(() => this.flushLogs(), this.flushDelay);
      // Cleanup beim Beenden
      if (typeof process !== 'undefined') {
        process.on('exit', () => this.flushLogs());
      }
    }
  }

  private flushLogs() {
    if (this.messageCounters.size === 0) return;

    for (const [pattern, count] of this.messageCounters.entries()) {
      if (count > 1) {
        this.logger.debug(`[SUMMARY] ${pattern}: ${count} similar logs`);
      }
    }
    this.messageCounters.clear();
  }

  private shouldSummarize(message: string): boolean {
    return this.messagePatterns.some(pattern => pattern.test(message));
  }

  private getMessagePattern(message: string): string {
    for (const pattern of this.messagePatterns) {
      const match = message.match(pattern);
      if (match) {
        // Längere Ausschnitte für Pattern und Kategorie verwenden
        const category = match[1] ? match[1].substring(0, 50) : 'unknown';
        // Pattern auch länger machen und besser formatieren
        const patternStr = pattern.toString().replace(/\\/g, '');
        const shortPattern = patternStr.substring(1, Math.min(40, patternStr.length - 1));

        // Formatierung: pattern >> category
        return `${shortPattern} >> ${category}`;
      }
    }

    // Wenn kein Muster passt, versuchen wir eine generische Gruppierung
    // Allgemeines Muster: Extrahiere erstes Wort oder Phrase bis zum ersten Doppelpunkt oder variable Werte
    const genericPattern = message.replace(/".+?"/g, '"..."').replace(/\d+/g, '#').substring(0, 60);
    return `Generic: ${genericPattern}`;
  }

  error(message: string, ...args: any[]): void {
    this.logger.error(message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.logger.warn(message, ...args);
  }

  info(message: string, ...args: any[]): void {
    this.logger.info(message, ...args);
  }

  debug(message: string, ...args: any[]): void {
    // Prüfen, ob logger überhaupt debug-Logs ausgeben würde
    if ((this.logger as any).shouldLog && !(this.logger as any).shouldLog('debug')) {
      return;
    }

    // Für Standard-Debug-Logs: Zusammenfassen wenn möglich
    if (this.shouldSummarize(message)) {
      const pattern = this.getMessagePattern(message);
      const count = (this.messageCounters.get(pattern) || 0) + 1;
      this.messageCounters.set(pattern, count);

      // Ersten Log immer ausgeben, danach nur noch in Zusammenfassungen
      if (count === 1) {
        this.logger.debug(message, ...args);
      }
    } else {
      // Für nicht erkannte Logs: Versuchen, sie generisch zu gruppieren
      const genericPattern = this.getMessagePattern(message);
      const count = (this.messageCounters.get(genericPattern) || 0) + 1;
      this.messageCounters.set(genericPattern, count);

      // Ersten Log jeder Art immer ausgeben
      if (count === 1) {
        this.logger.debug(message, ...args);
      }
    }
  }

  silly(message: string, ...args: any[]): void {
    this.logger.silly(message, ...args);
  }
}

/**
 * Client-side logger for use in browser environments
 */
export class ClientLogger implements Logger {
  level: string;

  constructor(level: string = 'info') {
    this.level = level;
  }

  error(message: string, ...args: any[]): void {
    console.error('[Easynews++]', message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn('[Easynews++]', message, ...args);
  }

  info(message: string, ...args: any[]): void {
    console.log('[Easynews++]', message, ...args);
  }

  debug(message: string, ...args: any[]): void {
    console.log('[Easynews++]', message, ...args);
  }

  silly(message: string, ...args: any[]): void {
    console.log('[Easynews++]', message, ...args);
  }
}

export interface Logger {
  error(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
  silly(message: string, ...args: any[]): void;
  level?: string;
}

/**
 * Logger factory function
 * Creates a logger using Winston or Cloudflare logger based on environment
 *
 * Log levels can be set via environment variable: EASYNEWS_LOG_LEVEL
 * Valid values: error, warn, info, debug, silly, or silent
 */
export function createLogger(options?: {
  prefix?: string;
  enableSummary?: boolean;
  isCloudflare?: boolean;
  isClient?: boolean;
  level?: string;
  username?: string | (() => string | undefined);
  customEnv?: Record<string, any>; // For CFW
}) {
  // Default options
  const opts = {
    prefix: 'general', // Default module name
    enableSummary: true,
    isCloudflare: process.env.CLOUDFLARE === 'true',
    isClient: typeof window !== 'undefined',
    username: undefined,
    ...options,
  };

  // Override for Cloudflare Worker (globalThis.caches)
  const isCloudflareWorkerViaCaches = typeof globalThis.caches !== 'undefined';
  if (isCloudflareWorkerViaCaches) {
    opts.isCloudflare = true;
  }

  // If opts.isCloudflare is true for any reason, disable summary.
  if (opts.isCloudflare) {
    opts.enableSummary = false;
  }

  // Environment variables - mit Vorrang für explizit gesetztes Level
  const logLevel =
    opts.level?.toLowerCase() || process.env.EASYNEWS_LOG_LEVEL?.toLowerCase() || 'info';
  const enableSummary =
    opts.enableSummary && process.env.EASYNEWS_SUMMARIZE_LOGS?.toLowerCase() !== 'false';

  // If we're in a browser environment, use the client logger
  if (opts.isClient) {
    return new ClientLogger(logLevel);
  }

  let baseLogger;

  // Use simple logger for Cloudflare environment
  if (opts.isCloudflare) {
    // Pass customEnv if available, for Cloudflare worker
    baseLogger = new CloudflareLogger(logLevel, opts.username, opts.prefix, opts.customEnv);
  } else {
    // Use Winston for all other environments
    if (!winston) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      winston = require('winston');
    }

    baseLogger = winston!.createLogger({
      level: logLevel,
      format: winston!.format.combine(
        winston!.format.colorize(),
        winston!.format.printf(info => {
          const splat = info[Symbol.for('splat')] || [];
          let msg = info.message;
          if (splat && Array.isArray(splat) && splat.length > 0) {
            const args = splat
              .map((arg: any) => (typeof arg === 'object' ? JSON.stringify(arg) : arg))
              .join(' ');
            msg = `${msg} ${args}`;
          }

          let user = 'system'; // Default username
          if (opts.username) {
            const actualUsername =
              typeof opts.username === 'function' ? opts.username() : opts.username;
            if (actualUsername) {
              user = actualUsername;
            }
          }
          const moduleName = opts.prefix || 'general'; // Use opts.prefix as module, default to 'general'

          // Strip color codes from info.level before converting to uppercase for consistent format
          const level = info.level.replace(/\[[0-9;]*m/g, '').toUpperCase();
          const discordLevel = level.toUpperCase(); // e.g. INFO, ERROR

          // Send to Discord from here as we have the formatted message (msg) and level
          // process.env will be used by sendToDiscord by default here.
          let messageForDiscord: string;
          if (msg instanceof Error) {
            messageForDiscord = msg.stack || msg.message; // Prefer stack if available
          } else if (typeof msg === 'object' && msg !== null) {
            // Attempt to stringify, but catch circular references or other errors
            try {
              messageForDiscord = JSON.stringify(msg);
            } catch (e) {
              messageForDiscord = '[Logger] Failed to stringify object for Discord';
            }
          } else {
            messageForDiscord = String(msg); // Fallback for primitives or other types
          }
          sendToDiscord(messageForDiscord, discordLevel).catch(console.error);

          return `${level} [v${getVersion()}][${moduleName}][${user}]: ${msg}`;
        })
      ),
      transports: [new winston!.transports.Console()],
    });
  }

  // Wrap with summary logger if enabled
  // The sendToDiscord calls are now in the baseLoggers (CloudflareLogger or Winston)
  return enableSummary ? new SummaryLogger(baseLogger) : baseLogger;
}

// Export a default logger instance for immediate use
export const logger = createLogger();
