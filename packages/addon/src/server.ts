import express, { Request, Response, NextFunction } from 'express';
import { AddonInterface } from 'stremio-addon-sdk';
import { Buffer } from 'buffer';
import { http, https } from 'follow-redirects';
import { IncomingMessage } from 'http';
import path from 'path';
// Import getRouter manually since TypeScript definitions are incomplete
// @ts-ignore
import getRouter from 'stremio-addon-sdk/src/getRouter';
import customTemplate from './custom-template';
import { addonInterface } from './addon';
import { URL } from 'url';
import { createLogger, getVersion } from 'easynews-plus-plus-shared';

export const logger = createLogger({
  prefix: 'Server', // Module name
  level: process.env.EASYNEWS_LOG_LEVEL || undefined,
});

type ServerOptions = {
  port?: number;
  cache?: number;
  cacheMaxAge?: number;
  static?: string;
};

// Helper function to create a deep clone of the manifest with a specified language
function createManifestWithLanguage(addonInterface: AddonInterface, lang: string) {
  const manifest = JSON.parse(JSON.stringify(addonInterface.manifest)); // Deep clone
  logger.debug(`Creating manifest clone for language: ${lang}`);

  // Find and update the uiLanguage field
  if (manifest.config) {
    const uiLangFieldIndex = manifest.config.findIndex((field: any) => field.key === 'uiLanguage');
    if (uiLangFieldIndex >= 0 && lang) {
      logger.debug(`Setting language in manifest to: ${lang}`);
      manifest.config[uiLangFieldIndex].default = lang;
    } else {
      logger.debug(`No language field found in manifest or empty language: ${lang}`);
    }
  }

  return manifest;
}

function serveHTTP(addonInterface: AddonInterface, opts: ServerOptions = {}) {
  if (addonInterface.constructor.name !== 'AddonInterface') {
    throw new Error('first argument must be an instance of AddonInterface');
  }

  logger.debug(`Creating Express server with options: ${JSON.stringify(opts)}`);
  const app = express();

  // Handle Cache-Control
  const cacheMaxAge = opts.cacheMaxAge || opts.cache;
  if (cacheMaxAge) {
    logger.debug(`Setting cache max age to: ${cacheMaxAge}`);
    app.use((_: Request, res: Response, next: NextFunction) => {
      if (!res.getHeader('Cache-Control'))
        res.setHeader('Cache-Control', 'max-age=' + cacheMaxAge + ', public');
      next();
    });
  }

  // Use the standard router from the SDK
  app.use(getRouter(addonInterface));
  logger.debug('Stremio Router middleware attached');

  // The important part: Use our custom template with internationalization
  const hasConfig = !!(addonInterface.manifest.config || []).length;
  logger.debug(`Addon has configuration: ${hasConfig}`);

  // Request logging middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(`Received ${req.method} request for: ${req.originalUrl || req.url}`);
    next();
  });

  // Landing page
  app.get('/', (req: Request, res: Response) => {
    logger.debug(`Handling root request with query params: ${JSON.stringify(req.query)}`);
    if (hasConfig) {
      // Pass any language parameter to the configure route
      const lang = (req.query.lang as string) || '';
      const redirectUrl = lang ? `/configure?lang=${lang}` : '/configure';
      logger.debug(`Redirecting to configuration page: ${redirectUrl}`);
      res.redirect(redirectUrl);
    } else {
      res.setHeader('content-type', 'text/html');
      // Generate the landing HTML with the default language
      logger.debug('Generating landing page HTML with default manifest');
      const landingHTML = customTemplate(addonInterface.manifest);
      res.end(landingHTML);
    }
  });

  // Resolve endpoint for stream requests
  app.get('/resolve/:payload/:filename', async (req: Request, res: Response) => {
    let username: string | undefined;
    const { payload, filename } = req.params;

    try {
      // Expect a Base64URL-encoded URL in the payload
      const encodedUrl = payload as string;
      if (!encodedUrl) {
        // Use global logger here as username might not be available yet for a request-specific one
        logger.warn(`Missing URL payload in /resolve request for file: ${filename}`);
        res.status(400).send('Missing url parameter');
        return;
      }

      let targetUrl: string;
      try {
        // Decode the Base64URL payload back into the Easynews URL with credentials as query-params
        targetUrl = Buffer.from(encodedUrl, 'base64url').toString('utf-8');
      } catch (decodeError) {
        // Use global logger here
        logger.warn(
          `Invalid URL encoding in /resolve for file: ${filename}. Payload: ${payload}`,
          decodeError
        );
        res.status(400).send('Invalid url encoding');
        return;
      }

      const parsed = new URL(targetUrl);
      // Extract and remove credentials
      username = parsed.searchParams.get('u') || '';
      const password = parsed.searchParams.get('p') || '';

      const requestLogger = createLogger({
        prefix: 'Server', // Module name
        level: process.env.EASYNEWS_LOG_LEVEL || undefined,
        username: username || 'unknown_resolve_user',
      });

      parsed.searchParams.delete('u');
      parsed.searchParams.delete('p');
      const cleanUrl = parsed.toString();
      requestLogger.debug(`Cleaned URL for upstream request: ${cleanUrl}`);
      requestLogger.info(`Handling /resolve request for file: ${filename}`);
      requestLogger.debug(`Payload for ${filename}: ${payload}`);
      requestLogger.debug(`Decoded target URL: ${targetUrl}`);

      const host = parsed.hostname.toLowerCase();
      const allowedDomain = /^([a-z0-9-]+\.)*easynews\.com$/i;
      if (!allowedDomain.test(host)) {
        requestLogger.warn(
          `Denied /resolve request for invalid domain: ${host}. Target URL: ${targetUrl}`
        );
        res.status(403).send('Domain not allowed');
        return;
      }

      // Choose the correct client
      const client = cleanUrl.startsWith('https:') ? https : http;

      requestLogger.info(`Making upstream GET request to: ${cleanUrl}`);
      // GET-only request with Range header to follow redirects and get final URL
      const request = client.request(
        cleanUrl,
        {
          method: 'GET',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
            Range: 'bytes=0-0', // only fetch first byte
          },
          maxRedirects: 5,
        },
        // Redirect client to the real CDN URL
        (upstream: IncomingMessage & { responseUrl?: string }) => {
          const finalUrl = upstream.responseUrl || cleanUrl;
          requestLogger.info(
            `Successfully redirecting client for ${cleanUrl} to final URL: ${finalUrl}`
          );
          res.redirect(307, finalUrl);
        }
      );

      request.on('error', (err: Error) => {
        // requestLogger is in scope here
        requestLogger.error(`Error resolving stream ${cleanUrl}: ${err.message}`, err);
        if (!res.headersSent) {
          res.status(502).send('Error resolving stream');
        }
      });

      request.end();
    } catch (error: any) {
      // Determine username for logging, could be undefined if parsing failed early
      // or if error happened before requestLogger was initialized.
      // Create a specific logger for this error context.
      const activeUsername = username || 'unknown_resolve_error_path'; // username is from the outer scope
      const errorLogger = createLogger({
        prefix: 'Server', // Module name
        level: process.env.EASYNEWS_LOG_LEVEL || undefined,
        username: activeUsername,
      });
      errorLogger.error(
        `Unexpected error in /resolve handler for file ${filename}: ${error.message}`,
        error
      );
      if (!res.headersSent) {
        res.status(500).send('Internal server error');
      }
    }
  });

  if (hasConfig)
    app.get('/configure', (req: Request, res: Response) => {
      // Set no-cache headers
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('content-type', 'text/html');

      // Get language from query parameter
      const lang = (req.query.lang as string) || '';
      logger.debug(`Express server: Received configure request with lang=${lang}`);

      // Generate HTML with the selected language
      let tempManifest;

      // If a language is specified, create a specialized manifest for that language
      if (lang) {
        logger.debug(`Creating manifest with specific language: ${lang}`);
        tempManifest = createManifestWithLanguage(addonInterface, lang);
      } else {
        // Otherwise, use the default manifest
        logger.debug('Using default manifest (no language specified)');
        tempManifest = addonInterface.manifest;
      }

      // Generate HTML with the updated language
      logger.debug('Generating configuration page HTML');
      const landingHTML = customTemplate(tempManifest);
      res.end(landingHTML);
    });

  // Static files, if specified
  if (opts.static) {
    const location = path.join(process.cwd(), opts.static);
    logger.debug(`Setting up static file serving from: ${location}`);
    try {
      const fs = require('fs');
      if (!fs.existsSync(location)) {
        logger.warn(`Static directory does not exist: ${location}`);
        throw new Error('directory to serve does not exist');
      }
      app.use(opts.static, express.static(location));
      logger.debug(`Static file middleware attached for path: ${opts.static}`);
    } catch (e) {
      logger.error('Error setting up static directory:', e);
    }
  }

  // Start the server
  logger.debug(`Starting server on port: ${opts.port || process.env.PORT || 7000}`);
  const server = app.listen(opts.port || process.env.PORT || 7000);

  return new Promise(function (resolve, reject) {
    server.on('listening', function () {
      const addressInfo = server.address();
      const port = typeof addressInfo === 'object' ? addressInfo?.port : null;
      const url = `http://127.0.0.1:${port}/manifest.json`;
      logger.info(`Server started successfully on port: ${port}`);
      logger.info(`Addon accessible at: ${url}`);
      resolve({ url, server });
    });
    server.on('error', (err: Error) => {
      logger.error(`Server failed to start: ${err.message}`, err); // Changed to error and added err object
      reject(err);
    });
  });
}

// Start the server with the addon interface
logger.debug(`Starting addon server with interface: ${addonInterface.manifest.id}`);
serveHTTP(addonInterface, { port: +(process.env.PORT ?? 1337) }).catch((err: Error) => {
  logger.error('Server failed to start:', err);
  process.exitCode = 1;
});

// Log environment configuration
logger.info('--- Environment configuration ---');
logger.info(`PORT: ${process.env.PORT || 'undefined'}`);
logger.info(`LOG_LEVEL: ${logger.level || 'undefined'}`);
logger.info(`VERSION: ${getVersion() || 'undefined'}`);

// Log API search configuration
logger.info('--- API search configuration ---');
logger.info(`TOTAL_MAX_RESULTS: ${process.env.TOTAL_MAX_RESULTS || 'undefined'}`);
logger.info(`MAX_PAGES: ${process.env.MAX_PAGES || 'undefined'}`);
logger.info(`MAX_RESULTS_PER_PAGE: ${process.env.MAX_RESULTS_PER_PAGE || 'undefined'}`);
logger.info(`CACHE_TTL: ${process.env.CACHE_TTL || 'undefined'}`);

// Log if TMDB is enabled
logger.info('--- TMDB configuration ---');
logger.info(`TMDB Integration: ${process.env.TMDB_API_KEY ? 'Enabled' : 'Disabled'}`);
logger.info('--- End of configuration ---');

// Log if Chatwoot is enabled
logger.info('--- Chatwoot configuration ---');
logger.info(
  `Chatwoot Integration: ${process.env.CHATWOOT_ENABLED === 'true' ? 'Enabled' : 'Disabled'}`
);
logger.info(`Chatwoot URL: ${process.env.CHATWOOT_BASE_URL || 'Not set'}`);
logger.info(`Chatwoot Token: ${process.env.CHATWOOT_WEBSITE_TOKEN || 'Not set'}`);
