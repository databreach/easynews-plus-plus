import { Hono } from 'hono';
import { getRouter } from 'hono-stremio';
import { addonInterface, customTemplate } from 'easynews-plus-plus-addon';
import { getUILanguage } from 'easynews-plus-plus-addon/dist/i18n';
import { createLogger } from 'easynews-plus-plus-shared';

// Create a logger with CF prefix for better context and set Cloudflare environment
const logger = createLogger({ prefix: 'CF', isCloudflare: true });

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
app.get('/resolve/:payload/:filename', async c => {
  const encodedUrl = c.req.param('payload');
  const filename = c.req.param('filename');
  let username: string | null = null; // To be extracted after URL parsing
  let targetUrl: string = ''; // For logging in broader scope if cleanUrl fails
  let cleanUrl: string = ''; // For logging in broader scope

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

    const requestLogger = createLogger({
      prefix: 'CF', // Module name
      isCloudflare: true,
      level: process.env.EASYNEWS_LOG_LEVEL || undefined,
      username: username || 'cf_unknown_user',
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
    const loggerForError =
      username !== null
        ? createLogger({
            // Check if username was set (even if empty string)
            prefix: 'CF',
            isCloudflare: true,
            level: process.env.EASYNEWS_LOG_LEVEL || undefined,
            username: username || 'cf_catch_unknown',
          })
        : logger; // Fallback to global logger if username is still null (very early error)
    loggerForError.error(`Error resolving stream ${logUrl}: ${(err as Error).message}`, err);
    return c.text('Error resolving stream', 502);
  }
});

// Add the configure route for direct access with language selection
app.get('/configure', c => {
  logger.debug(
    `Received /configure request. RayID: ${c.req.header('cf-ray')}, User-Agent: ${c.req.header('user-agent')}`
  );

  // Set no-cache headers
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');

  const lang = c.req.query('lang') || '';
  const uiLanguage = getUILanguage(lang);

  logger.debug(
    `Cloudflare worker: Received request with lang=${lang}, using UI language ${uiLanguage}`
  );

  // Generate new HTML with the selected language
  let tempManifest;

  // If a language is specified, create a specialized manifest for that language
  if (lang) {
    logger.debug(`Creating customized manifest for language: ${lang}`);
    tempManifest = createManifestWithLanguage(lang);
  } else {
    // Otherwise, use the default manifest
    logger.debug('Using default manifest (no language specified)');
    tempManifest = addonInterface.manifest;
  }

  // Generate new HTML with the updated language
  logger.debug('Generating HTML with localized template');
  const localizedHTML = customTemplate(tempManifest);
  logger.debug(`Generated localized HTML (${localizedHTML.length} bytes)`);
  return c.html(localizedHTML);
});

// If we have a config, add a redirect from the root to configure
if ((addonInterface.manifest.config || []).length > 0) {
  logger.debug('Addon has configuration, setting up root redirect');
  app.get('/', c => {
    logger.debug(
      `Received / request. RayID: ${c.req.header('cf-ray')}, User-Agent: ${c.req.header('user-agent')}`
    );

    // Pass any language parameter to the configure route
    const lang = c.req.query('lang') || '';
    const redirectUrl = lang ? `/configure?lang=${lang}` : '/configure';
    logger.debug(`Cloudflare worker: Redirecting to ${redirectUrl}`);
    return c.redirect(redirectUrl);
  });
} else {
  logger.debug('Addon has no configuration, keeping default root route');
}

app.route('/', addonRouter as any);
logger.info('Router setup complete, Cloudflare Worker initialized');

export default app;
