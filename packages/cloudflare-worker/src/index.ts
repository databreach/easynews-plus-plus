import { Hono } from 'hono';
import { getRouter } from 'hono-stremio';
import { addonInterface, customTemplate } from 'easynews-plus-plus-addon';
import { getUILanguage } from 'easynews-plus-plus-addon/dist/i18n';
import { createLogger, Logger } from 'easynews-plus-plus-shared'; // Import Logger type if needed

// Define an interface for Cloudflare environment variables
export interface Env {
  DISCORD_WEBHOOK_URL?: string;
  DISCORD_BOT_NAME?: string;
  DISCORD_BOT_AVATAR?: string;
  DISCORD_LOG_LEVEL?: string;
  EASYNEWS_LOG_LEVEL?: string; // For existing logger level configuration
  // Add other bindings like KV, D1, R2, etc., as needed
  // EXAMPLE_KV_NAMESPACE: KVNamespace;
}

// Create a global logger. For Discord logs, this will rely on sendToDiscord's default
// behavior if customEnv is not set (e.g. process.env or no discord logging if URL isn't there)
// It's initialized outside request context, so direct access to `c.env` for `customEnv` isn't available here.
const logger: Logger = createLogger({ prefix: 'CF', isCloudflare: true });

// Create the router with the default HTML
logger.debug('Initializing Cloudflare Worker with addon interface');
const defaultHTML = customTemplate(addonInterface.manifest);
logger.debug(`Generated default HTML template (${defaultHTML.length} bytes)`);
const addonRouter = getRouter(addonInterface, { landingHTML: defaultHTML });
logger.debug('Created Stremio router with addon interface');

const app = new Hono();
logger.debug('Initialized Hono app');

// Helper function to create a deep clone of the manifest with a specified language
function createManifestWithLanguage(lang: string) {
  logger.debug(`Creating manifest clone for language: ${lang}`);
  const manifest = structuredClone(addonInterface.manifest);

  // Find and update the uiLanguage field
  if (manifest.config) {
    const uiLangFieldIndex = manifest.config.findIndex((field: any) => field.key === 'uiLanguage');
    if (uiLangFieldIndex >= 0 && lang) {
      logger.debug(`Setting language in manifest to: ${lang}`);
      manifest.config[uiLangFieldIndex].default = lang;
      logger.debug(`Updated manifest language setting to: ${lang}`);
    } else {
      logger.debug(`No uiLanguage field found in manifest config or empty language`);
    }
  } else {
    logger.debug('No config found in manifest');
  }

  return manifest;
}

// Add resolve endpoint for stream requests
app.get('/resolve/:payload/:filename', async (c: any) => {
  // c's type can be Hono Context if Hono types are fully set up
  const env = c.env as Env; // Cast c.env to our Env interface for type safety
  const encodedUrl = c.req.param('payload');
  const filename = c.req.param('filename');
  let username: string | null = null; // To be extracted after URL parsing
  let targetUrl: string = ''; // For logging in broader scope if cleanUrl fails
  let cleanUrl: string = ''; // For logging in broader scope

  // Attempt to create a logger with env early, but username might not be available yet.
  // Global logger 'logger' can be used for very early errors.
  // Once username is parsed, a more specific logger is created.

  try {
    if (!encodedUrl) {
      logger.warn(`Missing URL payload in /resolve request for file: ${filename}`); // Global logger
      return c.text('Missing url parameter', 400);
    }

    try {
      // Decode the Base64URL payload back into the Easynews URL with credentials as query-params
      targetUrl = Buffer.from(encodedUrl, 'base64url').toString('utf-8');
    } catch (decodeError) {
      logger.warn(
        `Invalid URL encoding in /resolve request for file: ${filename}. Payload: ${encodedUrl}`,
        decodeError
      ); // Global logger
      return c.text('Invalid url encoding', 400);
    }

    // Only accept hosts under easynews.com
    const parsed = new URL(targetUrl);
    username = parsed.searchParams.get('u'); // Extract username for logging

    const requestLogger: Logger = createLogger({
      prefix: 'CF', // Module name
      isCloudflare: true,
      level: env.EASYNEWS_LOG_LEVEL || undefined, // Use env for log level
      username: username || 'cf_unknown_user',
      customEnv: env, // Pass the Cloudflare env object for Discord logging
    });

    requestLogger.info(`Handling /resolve for file: ${filename}`);
    requestLogger.debug(`Payload for ${filename}: ${encodedUrl}`);
    requestLogger.debug(`Decoded target URL: ${targetUrl}`);

    const host = parsed.hostname.toLowerCase();
    const allowedDomain = /^([a-z0-9-]+\.)*easynews\.com$/i;
    if (!allowedDomain.test(host)) {
      requestLogger.warn(`Denied /resolve for invalid domain: ${host}. Target: ${targetUrl}`);
      return c.text('Domain not allowed', 403);
    }

    // Extract and remove credentials
    const password = parsed.searchParams.get('p') || ''; // Actual username is in the 'username' variable
    parsed.searchParams.delete('u');
    parsed.searchParams.delete('p');
    cleanUrl = parsed.toString();
    requestLogger.debug(`Cleaned URL for upstream: ${cleanUrl}`);

    // Create authorization header
    const auth = 'Basic ' + btoa(`${username || ''}:${password}`);

    requestLogger.info(`Making upstream GET to: ${cleanUrl}`);
    // Single GET with Range header to follow redirects and only download 1 byte
    const response = await fetch(cleanUrl, {
      method: 'GET',
      headers: {
        Authorization: auth,
        Range: 'bytes=0-0',
      },
      redirect: 'manual', // Important: we handle redirects to get the final URL
    });

    // If we got a 3xx (redirect), grab the Location header; otherwise fall back
    const location = response.headers.get('Location') || cleanUrl;
    requestLogger.info(`Successfully redirecting client for ${cleanUrl} to final: ${location}`);

    // Redirect to the final URL
    return c.redirect(location, 307);
  } catch (err) {
    const logUrl = cleanUrl || targetUrl; // Prefer cleanUrl if available
    // Use requestLogger if available, or create a new one for the catch block if username was determined
    const loggerForError: Logger =
      username !== null
        ? createLogger({
            prefix: 'CF',
            isCloudflare: true,
            level: env.EASYNEWS_LOG_LEVEL || undefined, // Use env for log level
            username: username || 'cf_catch_unknown',
            customEnv: env, // Pass the Cloudflare env object for Discord logging
          })
        : logger; // Fallback to global logger. It won't have customEnv here.
    loggerForError.error(`Error resolving stream ${logUrl}: ${(err as Error).message}`, err);

    // Example: Test error logging to Discord from CF worker
    if (filename === 'test-discord-error.mp4') {
      loggerForError.error('This is a specific test error from Cloudflare worker for Discord!');
    }

    return c.text('Error resolving stream', 502);
  }
});

// Add the configure route for direct access with language selection
app.get('/configure', (c: any) => {
  // c's type can be Hono Context
  const env = c.env as Env; // Cast c.env for type safety
  // Create a logger for this specific request, including customEnv
  const configureLogger: Logger = createLogger({
    prefix: 'CF-Configure',
    isCloudflare: true,
    level: env.EASYNEWS_LOG_LEVEL || undefined,
    customEnv: env,
  });

  configureLogger.debug(
    `Received /configure request. RayID: ${c.req.header('cf-ray')}, User-Agent: ${c.req.header('user-agent')}`
  );

  // Set no-cache headers
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');

  const lang = c.req.query('lang') || '';
  const uiLanguage = getUILanguage(lang);

  configureLogger.debug(
    `Cloudflare worker: Received request with lang=${lang}, using UI language ${uiLanguage}`
  );

  // Generate new HTML with the selected language
  let tempManifest;

  // If a language is specified, create a specialized manifest for that language
  if (lang) {
    configureLogger.debug(`Creating customized manifest for language: ${lang}`);
    tempManifest = createManifestWithLanguage(lang); // This function uses global 'logger' internally
  } else {
    // Otherwise, use the default manifest
    configureLogger.debug('Using default manifest (no language specified)');
    tempManifest = addonInterface.manifest;
  }

  // Generate new HTML with the updated language
  configureLogger.debug('Generating HTML with localized template');
  const localizedHTML = customTemplate(tempManifest);
  configureLogger.debug(`Generated localized HTML (${localizedHTML.length} bytes)`);
  return c.html(localizedHTML);
});

// If we have a config, add a redirect from the root to configure
if ((addonInterface.manifest.config || []).length > 0) {
  logger.debug('Addon has configuration, setting up root redirect'); // Global logger
  app.get('/', (c: any) => {
    // c's type can be Hono Context
    const env = c.env as Env; // Cast c.env for type safety
    const rootLogger: Logger = createLogger({
      prefix: 'CF-Root',
      isCloudflare: true,
      level: env.EASYNEWS_LOG_LEVEL || undefined,
      customEnv: env,
    });
    rootLogger.debug(
      `Received / request. RayID: ${c.req.header('cf-ray')}, User-Agent: ${c.req.header('user-agent')}`
    );

    // Pass any language parameter to the configure route
    const lang = c.req.query('lang') || '';
    const redirectUrl = lang ? `/configure?lang=${lang}` : '/configure';
    rootLogger.debug(`Cloudflare worker: Redirecting to ${redirectUrl}`);
    return c.redirect(redirectUrl);
  });
} else {
  logger.debug('Addon has no configuration, keeping default root route'); // Global logger
}

app.route('/', addonRouter as any);
logger.info('Router setup complete, Cloudflare Worker initialized'); // Global logger

// Standard Cloudflare Worker export
export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    // You can add any pre-processing or global error handling here if needed,
    // or pass `env` to Hono if Hono's factory supports it (Hono usually gets it from context).
    // For now, `c.env` inside routes is the primary way to access `env`.
    return app.fetch(request, env, ctx);
  },
};
