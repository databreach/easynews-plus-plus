import { Cache, ContentType } from 'stremio-addon-sdk';
import addonBuilder from 'stremio-addon-sdk/src/builder';
import { manifest } from './manifest';
import {
  buildSearchQuery,
  createStreamPath,
  createStreamUrl,
  getDuration,
  getFileExtension,
  getPostTitle,
  getQuality,
  getSize,
  isBadVideo,
  logError,
  matchesTitle,
  getAlternativeTitles,
  isAuthError,
  setUtilsUsername,
} from './utils';
import { EasynewsAPI, SearchOptions, EasynewsSearchResponse } from 'easynews-plus-plus-api';
import { publicMetaProvider } from './meta';
import { Stream } from './types';
import customTitlesJson from '../../../custom-titles.json';
import { getUILanguage, translations } from './i18n';
import { createLogger, Logger } from 'easynews-plus-plus-shared';

// Extended configuration interface
interface AddonConfig {
  username: string;
  password?: string;
  strictTitleMatching?: string;
  preferredLanguage?: string;
  sortingPreference?: string;
  showQualities?: string; // Comma-separated list of qualities to show
  maxResultsPerQuality?: string; // Max results per quality
  maxFileSize?: string; // Max file size in GB
  baseUrl?: string; // Scheme, host and (optional port)
  [key: string]: any;
}

let currentUsername: string | undefined = undefined;

export const logger: Logger = createLogger({
  prefix: 'Addon', // This will be used as the module name
  level: process.env.EASYNEWS_LOG_LEVEL || undefined,
  username: () => currentUsername,
});

// Helper to create a localized auth error stream
function authErrorStream(langCode: string) {
  const lang = getUILanguage(langCode);
  let description =
    'Authentication Failed: Please check credentials and reconfigure addon. (Default)'; // Default fallback

  if (translations[lang] && translations[lang].errors && translations[lang].errors.authFailed) {
    description = translations[lang].errors.authFailed;
  } else if (
    translations['en'] &&
    translations['en'].errors &&
    translations['en'].errors.authFailed
  ) {
    // Fallback to English if preferred lang failed
    description = translations['en'].errors.authFailed;
    // Ensure logger is defined or imported if not already in scope, assuming it is:
    logger.warn(
      `Translation not found for lang '${lang}' or it was incomplete. Fell back to English for auth error.`
    );
  } else {
    // This case should ideally not be reached if 'en' is always present and complete
    // Ensure logger is defined or imported if not already in scope, assuming it is:
    logger.error(
      `Critical: English translation for authFailed is missing. Using hardcoded default.`
    );
  }

  return {
    streams: [
      {
        name: 'Easynews++ Auth Error',
        description: description,
        url: 'https://example.com/error', // Dummy URL that won't play
        behaviorHints: {
          notWebReady: true,
        },
      },
    ],
  };
}

// Default configuration values
const DEFAULT_CONFIG = {
  strictTitleMatching: 'true',
  preferredLanguage: '',
  sortingPreference: 'quality_first',
  showQualities: '4k,1080p,720p,480p',
  maxResultsPerQuality: '0',
  maxFileSize: '0',
};

const builder = new addonBuilder(manifest);

// In-memory request cache to reduce API calls and improve response times
const requestCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 1000 * 60 * 30; // 30 minutes

function getFromCache<T>(key: string): T | null {
  const cached = requestCache.get(key);
  if (!cached) return null;

  const now = Date.now();
  if (now - cached.timestamp > CACHE_TTL) {
    requestCache.delete(key);
    return null;
  }

  return cached.data as T;
}

function setCache<T>(key: string, data: T): void {
  requestCache.set(key, { data, timestamp: Date.now() });
}

// Load custom titles
let titlesFromFile: Record<string, string[]> = {};
let loadedPath = '';

try {
  // Always use the imported JSON by default
  logger.debug('Loading custom titles from imported custom-titles.json');
  titlesFromFile = customTitlesJson;
  loadedPath = 'imported';

  // Log some details about the loaded custom titles
  const numCustomTitles = Object.keys(titlesFromFile).length;
  logger.info(`Successfully loaded ${numCustomTitles} custom titles`);

  if (numCustomTitles > 0) {
    // Log an example to verify they're loaded correctly
    const examples = Object.entries(titlesFromFile).slice(0, 1);
    for (const [original, customTitles] of examples) {
      logger.debug(`Example custom title: "${original}" -> "${customTitles.join('", "')}"`);
    }
  } else {
    logger.warn(
      'No custom titles were loaded from the file. The file might be empty or have invalid format.'
    );
  }
} catch (error) {
  logger.error('Error loading custom titles file:', error);
  logger.info('Using imported custom titles as fallback');
  titlesFromFile = customTitlesJson;
}

// Import custom template for landing page
import customTemplate from './custom-template';

// Export landing HTML for Cloudflare Worker
export const landingHTML = customTemplate(manifest);

builder.defineStreamHandler(
  async ({ id, type, config }: { id: string; type: ContentType; config: AddonConfig }) => {
    // Check for essential config early
    if (!config || !config.username || !config.password) {
      logger.warn(
        'User configuration is incomplete. Username or password missing. Cannot process request.'
      );
      // Return an auth error stream or empty if preferredLanguage is not available
      return authErrorStream(config?.preferredLanguage || '');
    }
    currentUsername = config.username;
    setUtilsUsername(currentUsername);
    logger.debug(`Stream handler invoked for id: ${id}, type: ${type}`);

    try {
      // Apply default values for any missing configuration options
      const {
        username,
        password,
        strictTitleMatching = DEFAULT_CONFIG.strictTitleMatching,
        preferredLanguage = DEFAULT_CONFIG.preferredLanguage,
        sortingPreference = DEFAULT_CONFIG.sortingPreference,
        showQualities = DEFAULT_CONFIG.showQualities,
        maxResultsPerQuality = DEFAULT_CONFIG.maxResultsPerQuality,
        maxFileSize = DEFAULT_CONFIG.maxFileSize,
        baseUrl,
        ...options
      } = config;

      if (!id.startsWith('tt')) {
        return {
          streams: [],
        };
      }

      // Include settings in cache key to ensure
      // users with different settings get different cache results
      const cacheKey = `${id}:v3:user=${username}:strict=${strictTitleMatching === 'on' || strictTitleMatching === 'true'}:lang=${preferredLanguage || ''}:sort=${sortingPreference}:qualities=${showQualities || ''}:maxPerQuality=${maxResultsPerQuality || ''}:maxSize=${maxFileSize || ''}`;

      logger.debug(`Cache key: ${cacheKey}`);
      const cached = getFromCache<{ streams: Stream[] }>(cacheKey);

      if (cached) {
        logger.debug(`Cache hit for key: ${cacheKey}. Returning cached streams.`);
        return cached;
      }
      logger.debug(`Cache miss for key: ${cacheKey}. Proceeding to fetch streams.`);

      const useStrictMatching = strictTitleMatching === 'on' || strictTitleMatching === 'true';
      const preferredLang = preferredLanguage || '';

      // Log the fully resolved config, be mindful of sensitive data if any in future
      // For now, username/password are not logged here but are available via currentUsername for the logger prefix
      const resolvedConfigForLogging = { ...config };
      delete resolvedConfigForLogging.password; // Explicitly remove password from this log
      logger.debug(
        `Resolved config for user: ${username}, strict: ${useStrictMatching}, lang: ${preferredLang}, qualities: ${showQualities}, sort: ${sortingPreference}`
      );

      if (!username || !password) {
        // This check is theoretically redundant due to the one at the start of the handler,
        // but kept for safety in case of unexpected config state changes.
        logger.warn('Username or password became undefined during handler execution.');
        return authErrorStream(config.preferredLanguage || '');
      }

      if (!config.strictTitleMatching) {
        logger.debug(`Using default strictTitleMatching: ${strictTitleMatching}`);
      } else {
        // Parse strictTitleMatching option (checkbox returns string 'on' or undefined)
        logger.info(`Strict title matching: ${useStrictMatching ? 'enabled' : 'disabled'}`);
      }

      if (!config.preferredLanguage) {
        logger.debug(`Using default preferredLanguage: ${preferredLanguage || 'No preference'}`);
      } else {
        // Get preferred language from configuration
        logger.info(
          `Preferred language: ${preferredLanguage ? preferredLanguage : 'No preference'}`
        );
      }

      // Parse quality filters
      const qualityFilters = showQualities
        ? showQualities
            .split(',')
            .map(q => q.trim().toLowerCase())
            .filter(Boolean)
        : ['4k', '1080p', '720p', '480p'];

      if (!config.showQualities) {
        logger.debug('Using default showQualities: ' + showQualities);
      } else {
        logger.info(`Quality filters: ${qualityFilters.join(', ')}`);
      }

      // Parse max results per quality (0 = no limit)
      let maxResultsPerQualityValue = parseInt(maxResultsPerQuality ?? '0', 10);
      if (Number.isNaN(maxResultsPerQualityValue) || maxResultsPerQualityValue < 0) {
        maxResultsPerQualityValue = 0;
      }
      if (!config.maxResultsPerQuality) {
        logger.debug('Using default maxResultsPerQuality: ' + maxResultsPerQuality);
      } else {
        logger.info(
          `Max results per quality: ${maxResultsPerQualityValue === 0 ? 'No limit' : maxResultsPerQualityValue}`
        );
      }

      // Parse max file size (0 = no limit)
      let maxFileSizeGB = parseFloat(maxFileSize ?? '0');
      if (Number.isNaN(maxFileSizeGB) || maxFileSizeGB < 0) {
        maxFileSizeGB = 0;
      }
      if (!config.maxFileSize) {
        logger.debug('Using default maxFileSize: ' + maxFileSize);
      } else {
        logger.info(`Max file size: ${maxFileSizeGB === 0 ? 'No limit' : maxFileSizeGB + ' GB'}`);
      }

      // Use custom titles from custom-titles.json
      const customTitles = { ...titlesFromFile };

      logger.debug(
        `Using ${Object.keys(customTitles).length} custom titles from custom-titles.json`
      );

      if (!config.sortingPreference) {
        logger.debug(`Using default sortingPreference: ${sortingPreference}`);
      } else {
        logger.info(`Sorting preference from config: ${sortingPreference}`);
      }

      // Configure API sorting options based on user sorting preference
      const sortOptions: Partial<SearchOptions> = {
        query: '', // Will be set for each search later
      };

      // Set consistent API sorting parameters regardless of user sorting preference
      // This ensures we always get the same raw results
      // We'll handle user sorting preferences after fetching all results

      // Use parameters that give us the most complete results
      sortOptions.sort1 = 'relevance'; // Use relevance as primary sort
      sortOptions.sort1Direction = '-'; // Descending
      sortOptions.sort2 = 'dsize'; // Then size
      sortOptions.sort2Direction = '-'; // Descending
      // Set a consistent third sort option
      sortOptions.sort3 = 'dtime'; // DateTime
      sortOptions.sort3Direction = '-'; // Descending

      // Log the API sorting parameters
      logger.debug(
        `API Sorting: ${sortOptions.sort1} (${sortOptions.sort1Direction}), ${sortOptions.sort2} (${sortOptions.sort2Direction}), ${sortOptions.sort3} (${sortOptions.sort3Direction})`
      );

      const meta = await publicMetaProvider(id, type, preferredLanguage);

      // Original logger.debug call:
      logger.debug(
        `Fetched metadata for "${meta.name}" (Year: ${meta.year}, Type: ${meta.type}${type === 'series' && meta.season && meta.episode ? `, S${meta.season}E${meta.episode}` : ''})`
      );
      logger.info(`Searching for: ${meta.name}`);

      // Check if we have a custom title for this title directly
      if (customTitles[meta.name]) {
        logger.debug(
          `Direct custom title found for "${meta.name}": "${customTitles[meta.name].join('", "')}"`
        );
      } else {
        logger.debug(`No direct custom title found for "${meta.name}", checking partial matches`);

        // Look for partial matches in title keys
        for (const [key, values] of Object.entries(customTitles)) {
          if (
            meta.name.toLowerCase().includes(key.toLowerCase()) ||
            key.toLowerCase().includes(meta.name.toLowerCase())
          ) {
            logger.debug(
              `Possible title match: "${meta.name}" ~ "${key}" -> "${values.join('", "')}"`
            );
          }
        }
      }

      // Initialize the API with user credentials
      let api;
      try {
        api = new EasynewsAPI({ username, password });
      } catch (error) {
        logger.error(`API initialization error: ${error}`);
        return authErrorStream(config.preferredLanguage || '');
      }

      logger.debug(`Getting alternative titles for: ${meta.name}`);

      // Initialize with the original title
      let allTitles = [meta.name];
      logger.debug(
        `Initial allTitles count: ${allTitles.length}, first: ${allTitles.length > 0 ? allTitles[0] : 'N/A'}`
      );

      // Add any direct custom titles found in customTitles
      if (customTitles[meta.name] && customTitles[meta.name].length > 0) {
        logger.debug(
          `Adding direct custom titles for "${meta.name}": "${customTitles[meta.name].join('", "')}"`
        );
        allTitles = [...allTitles, ...customTitles[meta.name]];
        logger.debug(
          `allTitles after direct custom count: ${allTitles.length}, first: ${allTitles.length > 0 ? allTitles[0] : 'N/A'}`
        );
      }

      // Add any alternative names from meta (if available)
      if (meta.alternativeNames && meta.alternativeNames.length > 0) {
        logger.debug(
          `Adding ${meta.alternativeNames.length} alternative names from metadata (${meta.alternativeNames.join(', ')})`
        );
        // Filter out duplicates
        const newAlternatives = meta.alternativeNames.filter(alt => !allTitles.includes(alt));
        allTitles = [...allTitles, ...newAlternatives];
        logger.debug(
          `allTitles after meta alternatives count: ${allTitles.length}, first: ${allTitles.length > 0 ? allTitles[0] : 'N/A'}`
        );
      }

      // Use getAlternativeTitles to find additional matches (like partial matches)
      const additionalTitles = getAlternativeTitles(meta.name, customTitles).filter(
        alt => !allTitles.includes(alt) && alt !== meta.name
      );

      if (additionalTitles.length > 0) {
        logger.debug(`Adding ${additionalTitles.length} additional titles from partial matches`);
        allTitles = [...allTitles, ...additionalTitles];
        logger.debug(
          `allTitles after partial matches count: ${allTitles.length}, first: ${allTitles.length > 0 ? allTitles[0] : 'N/A'}`
        );
      }

      // Remove duplicates again just in case, and ensure original meta.name is first
      allTitles = [meta.name, ...new Set(allTitles.filter(t => t !== meta.name))];
      logger.info(
        `Final list of titles to search for (${allTitles.length}): ${allTitles.join('; ')}`
      );

      // Store all search results here
      const allSearchResults: {
        query: string;
        result: EasynewsSearchResponse;
      }[] = [];

      // Early exit condition - limit API calls
      const TOTAL_MAX_RESULTS = parseInt(process.env.TOTAL_MAX_RESULTS || '500');
      let totalFoundResults = 0;

      // Helper function to count total unique results across all searches
      const countTotalUniqueResults = () => {
        const uniqueHashes = new Set<string>();
        for (const { result } of allSearchResults) {
          for (const file of result.data ?? []) {
            const fileHash = file['0'];
            uniqueHashes.add(fileHash);
          }
        }
        return uniqueHashes.size;
      };

      // First try without year for each title variant
      for (const titleVariant of allTitles) {
        // Skip empty titles
        if (!titleVariant.trim()) continue;

        // Stop searching if we already have enough results
        if (totalFoundResults >= TOTAL_MAX_RESULTS) {
          logger.debug(
            `Already found ${totalFoundResults} unique results, skipping additional title searches`
          );
          break;
        }

        const titleMeta = { ...meta, name: titleVariant, year: undefined };
        const query = buildSearchQuery(type, titleMeta);
        logger.debug(
          `Preparing search for query: "${query}", SortOptions: ${JSON.stringify(sortOptions)}`
        );

        try {
          const res = await api.search({
            ...sortOptions,
            query,
          });

          const resultCount = res?.data?.length || 0;
          logger.debug(`Found ${resultCount} results for "${query}" without year`);

          if (resultCount > 0) {
            allSearchResults.push({ query, result: res });
            totalFoundResults = countTotalUniqueResults();
            logger.debug(`Total unique results so far: ${totalFoundResults}`);

            // Log a few examples of the results
            if (res.data && res.data.length > 0) {
              const firstFile = res.data[0];
              const firstTitle = getPostTitle(firstFile);
              logger.debug(
                `First example result for query "${query}": "${firstTitle}" (Size: ${firstFile['4'] || 'N/A'}, Hash: ${firstFile['0'] || 'N/A'})`
              );
            }
          }
        } catch (error) {
          logger.error(`Error searching for "${query}":`, error);

          // Check if it's an authentication error
          if (isAuthError(error)) return authErrorStream(config.preferredLanguage || '');

          // Continue with other titles even if one fails
        }
      }

      // If meta.year is defined, also search with year included (regardless of whether we found results without year)
      if (meta.year !== undefined) {
        // Skip year search if we already have enough results
        if (totalFoundResults >= TOTAL_MAX_RESULTS) {
          logger.debug(
            `Already found ${totalFoundResults} unique results, skipping year-based searches`
          );
        } else {
          // If we already found results without year, log that we're still searching with year
          if (allSearchResults.length > 0) {
            logger.debug(
              `Found ${totalFoundResults} unique results without year, also trying with year: ${meta.year}`
            );
          } else {
            logger.debug(`No results found without year, trying with year: ${meta.year}`);
          }

          for (const titleVariant of allTitles) {
            // Skip empty titles
            if (!titleVariant.trim()) continue;

            // Stop searching if we already have enough results
            if (totalFoundResults >= TOTAL_MAX_RESULTS) {
              logger.debug(
                `Already found ${totalFoundResults} unique results, skipping additional title searches with year`
              );
              break;
            }

            const titleMeta = { ...meta, name: titleVariant, year: meta.year };
            const query = buildSearchQuery(type, titleMeta);
            logger.debug(
              `Preparing search with year for query: "${query}", SortOptions: ${JSON.stringify(sortOptions)}`
            );

            try {
              const res = await api.search({
                ...sortOptions,
                query,
              });

              const resultCount = res?.data?.length || 0;
              logger.debug(`Found ${resultCount} results for "${query}" with year`);

              if (resultCount > 0) {
                allSearchResults.push({ query, result: res });
                totalFoundResults = countTotalUniqueResults();
                logger.debug(`Total unique results so far: ${totalFoundResults}`);

                // Log a few examples of the results
                if (res.data && res.data.length > 0) {
                  const firstFile = res.data[0];
                  const firstTitle = getPostTitle(firstFile);
                  logger.debug(
                    `First example result for query "${query}": "${firstTitle}" (Size: ${firstFile['4'] || 'N/A'}, Hash: ${firstFile['0'] || 'N/A'})`
                  );
                }
              }
            } catch (error) {
              logger.error(`Error searching for "${query}":`, error);

              // Check if it's an authentication error
              if (isAuthError(error)) return authErrorStream(config.preferredLanguage || '');

              // Continue with other titles even if one fails
            }
          }
        }
      }

      if (allSearchResults.length === 0) {
        return { streams: [] };
      }

      const processedHashes = new Set<string>();

      // Store all streams here
      let streams: Stream[] = [];

      // Apply global limit across all search results
      logger.debug(`Global stream limit: ${TOTAL_MAX_RESULTS} results across all searches`);

      // Process each search result
      for (const { query, result: res } of allSearchResults) {
        // Skip adding more results if we've already reached the limit
        if (streams.length >= TOTAL_MAX_RESULTS) {
          logger.debug(`Reached global limit of ${TOTAL_MAX_RESULTS} streams, stopping processing`);
          break;
        }

        for (const file of res.data ?? []) {
          // Check if we've reached the global limit
          if (streams.length >= TOTAL_MAX_RESULTS) {
            logger.debug(
              `Reached global limit of ${TOTAL_MAX_RESULTS} streams, stopping processing`
            );
            break;
          }

          const title = getPostTitle(file);
          const fileHash = file['0']; // Use file hash to detect duplicates

          if (isBadVideo(file)) {
            logger.debug(`Rejected stream (bad video): "${title}", File hash: ${file['0']}`);
            continue;
          }
          if (processedHashes.has(fileHash)) {
            logger.debug(`Rejected stream (duplicate hash): "${title}", Hash: ${fileHash}`);
            continue;
          }

          processedHashes.add(fileHash);

          // For series there are multiple possible queries that could match the title.
          // We check if at least one of them matches.
          if (type === 'series') {
            // Create queries for all title variants
            const queries: string[] = [];

            for (const titleVariant of allTitles) {
              // Add full query with season and episode
              const fullMeta = {
                ...meta,
                name: titleVariant,
                year: meta.year,
              };
              queries.push(buildSearchQuery(type, fullMeta));

              // Add query with episode only
              const episodeMeta = {
                name: titleVariant,
                episode: meta.episode,
              };
              queries.push(buildSearchQuery(type, episodeMeta));
            }

            // Use strictTitleMatching setting if enabled for series
            if (!queries.some(q => matchesTitle(title, q, useStrictMatching))) {
              logger.debug(`Rejected series by title matching: "${title}"`);
              continue;
            }
          }

          // For movies, check if title matches any of the query variants
          // Other content types are loosely matched
          const matchesAnyVariant = allTitles.some(titleVariant => {
            const variantQuery = buildSearchQuery(type, {
              ...meta,
              name: titleVariant,
            });
            // For movies, only use strictTitleMatching if enabled by user, just like for series
            return matchesTitle(title, variantQuery, useStrictMatching);
          });

          if (!matchesAnyVariant) {
            logger.debug(`Rejected ${type} by title matching: "${title}"`);
            continue;
          }

          streams.push(
            mapStream({
              username,
              password,
              fullResolution: file.fullres,
              fileExtension: getFileExtension(file),
              duration: getDuration(file),
              size: getSize(file),
              title,
              url: createStreamUrl(
                { downURL: res.downURL, dlFarm: res.dlFarm, dlPort: res.dlPort },
                username,
                password,
                createStreamPath(file),
                baseUrl
              ),
              videoSize: file.rawSize,
              file,
              preferredLang,
            })
          );
        }
      }

      // Sort streams based on user preference
      if (sortingPreference === 'language_first' && preferredLang) {
        logger.debug(`Applying language-first sorting for language: ${preferredLang}`);

        // Special handling for language-first sorting
        // First, separate streams by language
        const preferredLangStreams: Stream[] = [];
        const otherStreams: Stream[] = [];

        // Split streams into two groups
        for (const stream of streams) {
          const file = (stream as any)._temp?.file;
          const hasPreferredLang =
            file?.alangs && Array.isArray(file.alangs) && file.alangs.includes(preferredLang);

          if (hasPreferredLang) {
            preferredLangStreams.push(stream);
          } else {
            otherStreams.push(stream);
          }
        }

        logger.debug(
          `Found ${preferredLangStreams.length} streams with preferred language and ${otherStreams.length} other streams`
        );

        // Sort each group by quality and size
        const sortByQualityAndSize = (a: Stream, b: Stream) => {
          // Extract quality info
          const aDesc = a.description?.split('\n') || [];
          const bDesc = b.description?.split('\n') || [];
          const aQuality = a.name?.includes('\n') ? a.name.split('\n')[1] : '';
          const bQuality = b.name?.includes('\n') ? b.name.split('\n')[1] : '';

          // Get quality scores with improved 4K detection
          const getQualityScore = (quality: string): number => {
            if (!quality) return 0;

            // Standardize the quality string for comparison
            const q = quality.toUpperCase();

            // Check for 4K indicators (multiple ways to indicate 4K)
            if (
              q.includes('4K') ||
              q.includes('2160P') ||
              q.includes('UHD') ||
              q.includes('2160') ||
              q.includes('ULTRA HD')
            )
              return 4;

            // Check for 1080p
            if (q.includes('1080P') || q.includes('1080')) return 3;

            // Check for 720p
            if (q.includes('720P') || q.includes('720')) return 2;

            // Check for 480p/SD
            if (q.includes('480P') || q.includes('480') || q.includes('SD')) return 1;

            return 0;
          };
          const aScore = getQualityScore(aQuality);
          const bScore = getQualityScore(bQuality);

          // Compare quality scores
          if (aScore !== bScore) {
            return bScore - aScore;
          }

          // Compare sizes
          const aSize = aDesc.length > 2 ? aDesc[2] : '';
          const bSize = bDesc.length > 2 ? bDesc[2] : '';

          if (aSize.includes('GB') && bSize.includes('GB')) {
            const aGB = parseFloat(aSize.match(/[\d.]+/)?.[0] || '0');
            const bGB = parseFloat(bSize.match(/[\d.]+/)?.[0] || '0');
            if (aGB > bGB) return -1;
            if (aGB < bGB) return 1;
          }

          if (aSize.includes('GB') && bSize.includes('MB')) return -1;
          if (aSize.includes('MB') && bSize.includes('GB')) return 1;

          if (aSize.includes('MB') && bSize.includes('MB')) {
            const aMB = parseFloat(aSize.match(/[\d.]+/)?.[0] || '0');
            const bMB = parseFloat(bSize.match(/[\d.]+/)?.[0] || '0');
            if (aMB > bMB) return -1;
            if (aMB < bMB) return 1;
          }

          return 0;
        };

        // Sort each group independently
        preferredLangStreams.sort(sortByQualityAndSize);
        otherStreams.sort(sortByQualityAndSize);

        // Replace streams array with the concatenated sorted groups
        streams.length = 0;
        streams.push(...preferredLangStreams, ...otherStreams);
      } else {
        // Original sorting for other preferences
        streams.sort((a, b) => {
          // Extract stream data
          const aFile = (a as any)._temp?.file;
          const bFile = (b as any)._temp?.file;
          const aHasPreferredLang = preferredLang && aFile?.alangs?.includes(preferredLang);
          const bHasPreferredLang = preferredLang && bFile?.alangs?.includes(preferredLang);

          // Extract quality info
          const aDesc = a.description?.split('\n') || [];
          const bDesc = b.description?.split('\n') || [];
          const aQuality = a.name?.includes('\n') ? a.name.split('\n')[1] : '';
          const bQuality = b.name?.includes('\n') ? b.name.split('\n')[1] : '';

          // Get quality scores with improved 4K detection
          const getQualityScore = (quality: string): number => {
            if (!quality) return 0;

            // Standardize the quality string for comparison
            const q = quality.toUpperCase();

            // Check for 4K indicators (multiple ways to indicate 4K)
            if (
              q.includes('4K') ||
              q.includes('2160P') ||
              q.includes('UHD') ||
              q.includes('2160') ||
              q.includes('ULTRA HD')
            )
              return 4;

            // Check for 1080p
            if (q.includes('1080P') || q.includes('1080')) return 3;

            // Check for 720p
            if (q.includes('720P') || q.includes('720')) return 2;

            // Check for 480p/SD
            if (q.includes('480P') || q.includes('480') || q.includes('SD')) return 1;

            return 0;
          };
          const aScore = getQualityScore(aQuality);
          const bScore = getQualityScore(bQuality);

          // Size comparison logic
          const compareSize = () => {
            const aSize = aDesc.length > 2 ? aDesc[2] : '';
            const bSize = bDesc.length > 2 ? bDesc[2] : '';

            // Extract only the size part (before any date information)
            const aSizePart = aSize.split('📅')[0].trim();
            const bSizePart = bSize.split('📅')[0].trim();

            if (aSizePart.includes('GB') && bSizePart.includes('GB')) {
              const aGB = parseFloat(aSizePart.match(/[\d.]+/)?.[0] || '0');
              const bGB = parseFloat(bSizePart.match(/[\d.]+/)?.[0] || '0');
              if (aGB > bGB) return -1;
              if (aGB < bGB) return 1;
            }

            if (aSizePart.includes('GB') && bSizePart.includes('MB')) return -1;
            if (aSizePart.includes('MB') && bSizePart.includes('GB')) return 1;

            if (aSizePart.includes('MB') && bSizePart.includes('MB')) {
              const aMB = parseFloat(aSizePart.match(/[\d.]+/)?.[0] || '0');
              const bMB = parseFloat(bSizePart.match(/[\d.]+/)?.[0] || '0');
              if (aMB > bMB) return -1;
              if (aMB < bMB) return 1;
            }

            return 0;
          };

          // Apply sorting based on user preference
          switch (sortingPreference) {
            case 'size_first':
              // Size first, then quality, then language
              const sizeCompare = compareSize();
              if (sizeCompare !== 0) {
                return sizeCompare;
              }
              if (aScore !== bScore) {
                return bScore - aScore;
              }
              if (aHasPreferredLang !== bHasPreferredLang) {
                return aHasPreferredLang ? -1 : 1;
              }
              return 0;

            case 'date_first':
              // Sort by date first using the file's date info
              const aDate = aFile?.['5'] ? new Date(aFile['5']).getTime() : 0;
              const bDate = bFile?.['5'] ? new Date(bFile['5']).getTime() : 0;
              if (aDate !== bDate) {
                // Higher date value (more recent) comes first - descending order
                return bDate - aDate;
              }
              // Then quality
              if (aScore !== bScore) {
                return bScore - aScore;
              }
              // Then language
              if (aHasPreferredLang !== bHasPreferredLang) {
                return aHasPreferredLang ? -1 : 1;
              }
              // Then size
              return compareSize();

            case 'lang_first':
            case 'language_first':
              // Language first, then quality, then size
              if (aHasPreferredLang !== bHasPreferredLang) {
                return aHasPreferredLang ? -1 : 1;
              }
              if (aScore !== bScore) {
                return bScore - aScore;
              }
              return compareSize();

            case 'quality_first':
            default:
              // Quality first (default), then language, then size
              // Make sure the quality score comparison is working
              if (aScore !== bScore) {
                // Higher quality score first - ensure descending order
                return bScore - aScore;
              }
              // Then language
              if (aHasPreferredLang !== bHasPreferredLang) {
                return aHasPreferredLang ? -1 : 1;
              }
              // Then size
              return compareSize();
          }
        });
      }

      // After all streams have been collected, first filter and limit them based on user settings
      const originalCount = streams.length;
      if (streams.length > 0) {
        logger.debug(`Starting filters with ${originalCount} streams`);

        // Filter streams by quality
        const defaultQualitySet = ['4k', '1080p', '720p', '480p'];
        const isCustomQualityFilter = !(
          qualityFilters.length === defaultQualitySet.length &&
          qualityFilters.every(q => defaultQualitySet.includes(q))
        );

        if (isCustomQualityFilter) {
          logger.debug(
            `Applying custom quality filtering. Initial stream count: ${streams.length}. Filters: ${qualityFilters.join(', ')}`
          );
          const qualityMap: Record<string, string[]> = {
            '4k': ['4K', 'UHD', '2160p'],
            '1080p': ['1080p'],
            '720p': ['720p'],
            '480p': ['480p', 'SD'],
          };

          // Create a list of allowed quality strings
          const allowedQualityTerms: string[] = [];
          qualityFilters.forEach(q => {
            if (qualityMap[q]) {
              allowedQualityTerms.push(...qualityMap[q]);
            }
          });

          logger.debug(`Filtering for qualities: ${qualityFilters.join(', ')}`);
          logger.debug(`Accepted quality terms: ${allowedQualityTerms.join(', ')}`);

          if (allowedQualityTerms.length > 0) {
            const streamsBeforeQualityFilter = streams.length;
            const filteredStreams = streams.filter(stream => {
              const quality = stream.name?.split('\n')[1] || '';
              const matchesQuality = allowedQualityTerms.some(term => quality.includes(term));
              return matchesQuality;
            });

            // Only update if we found at least one match
            if (filteredStreams.length > 0) {
              streams = filteredStreams;
              logger.debug(
                `After quality filtering: ${streams.length} streams remain (was ${streamsBeforeQualityFilter})`
              );
            } else {
              logger.warn(
                `Quality filtering (terms: ${allowedQualityTerms.join(', ')}) would remove all ${streamsBeforeQualityFilter} streams - keeping original results`
              );
            }
          }
        }

        // Filter streams by file size (only if maxFileSizeGB > 0)
        if (maxFileSizeGB > 0) {
          logger.debug(
            `Applying max file size filtering. Limit: ${maxFileSizeGB}GB. Initial stream count: ${streams.length}`
          );
          const streamsBeforeSizeFilter = streams.length;
          const filteredStreams = streams.filter(stream => {
            const description = stream.description || '';
            const sizeLine = description.split('\n').find(line => line.includes('📦'));

            if (!sizeLine) return true; // Keep if we can't determine size

            // Extract only the size part (before any date information)
            const sizePart = sizeLine.split('📅')[0].trim();

            if (sizePart.includes('GB')) {
              const sizeGB = parseFloat(sizePart.match(/[\d.]+/)?.[0] || '0');
              return sizeGB <= maxFileSizeGB;
            }

            if (sizePart.includes('MB')) {
              const sizeMB = parseFloat(sizePart.match(/[\d.]+/)?.[0] || '0');
              return sizeMB / 1024 <= maxFileSizeGB;
            }

            return true; // Keep if we can't parse the size
          });

          // Only update if we found at least one match
          if (filteredStreams.length > 0) {
            streams = filteredStreams;
            logger.debug(
              `After max file size filtering: ${streams.length} streams remain (was ${streamsBeforeSizeFilter})`
            );
          } else {
            logger.warn(
              `Max file size filtering (${maxFileSizeGB}GB) would remove all ${streamsBeforeSizeFilter} streams - keeping original results`
            );
          }
        }

        // Group streams by quality for limiting per quality (only if maxResultsPerQualityValue > 0)
        if (maxResultsPerQualityValue > 0) {
          logger.debug(
            `Applying max results per quality. Limit: ${maxResultsPerQualityValue}. Initial stream count: ${streams.length}`
          );
          const streamsByQuality: Record<string, Stream[]> = {};

          // Determine quality category for each stream
          streams.forEach(stream => {
            const quality = stream.name?.split('\n')[1] || '';
            let qualityCategory = 'other';

            if (quality.includes('4K') || quality.includes('UHD') || quality.includes('2160p')) {
              qualityCategory = '4k';
            } else if (quality.includes('1080p')) {
              qualityCategory = '1080p';
            } else if (quality.includes('720p')) {
              qualityCategory = '720p';
            } else if (quality.includes('480p') || quality.includes('SD')) {
              qualityCategory = '480p';
            }

            if (!streamsByQuality[qualityCategory]) {
              streamsByQuality[qualityCategory] = [];
            }
            streamsByQuality[qualityCategory].push(stream);
          });

          // Log the distribution of streams by quality
          Object.entries(streamsByQuality).forEach(([quality, qualityStreamList]) => {
            logger.debug(
              `Pre-limit count for quality ${quality}: ${qualityStreamList.length} streams`
            );
          });

          // Apply limits per quality category and rebuild streams array
          const limitedStreams: Stream[] = [];
          const streamsBeforePerQualityLimit = streams.length;
          Object.keys(streamsByQuality).forEach(quality => {
            const qualityStreams = streamsByQuality[quality];
            const limitedQualityStreams = qualityStreams.slice(0, maxResultsPerQualityValue);
            limitedStreams.push(...limitedQualityStreams);

            if (limitedQualityStreams.length < qualityStreams.length) {
              logger.debug(
                `Quality ${quality}: Limited from ${qualityStreams.length} to ${limitedQualityStreams.length} streams`
              );
            }
          });

          if (limitedStreams.length > 0) {
            streams = limitedStreams;
            logger.debug(
              `After applying max results per quality: ${streams.length} streams remain (was ${streamsBeforePerQualityLimit})`
            );
          } else {
            logger.warn(
              `Per-quality limiting (limit: ${maxResultsPerQualityValue}) would remove all ${streamsBeforePerQualityLimit} streams - keeping original results`
            );
          }
        }

        logger.info(`Filtering complete: ${originalCount} streams → ${streams.length} streams`);
      }
      const streamCountBeforeSort = streams.length;
      logger.debug(
        `Preparing to sort ${streamCountBeforeSort} streams. Preference: ${sortingPreference}, Language: ${preferredLang || 'none'}`
      );

      // Now sort the filtered streams based on user preference
      if (sortingPreference === 'language_first' && preferredLang) {
        logger.debug(`Applying language-first sorting for language: ${preferredLang}`);

        // Special handling for language-first sorting
        // First, separate streams by language
        const preferredLangStreams: Stream[] = [];
        const otherStreams: Stream[] = [];

        // Split streams into two groups
        for (const stream of streams) {
          const file = (stream as any)._temp?.file;
          const hasPreferredLang =
            file?.alangs && Array.isArray(file.alangs) && file.alangs.includes(preferredLang);

          if (hasPreferredLang) {
            preferredLangStreams.push(stream);
          } else {
            otherStreams.push(stream);
          }
        }

        logger.debug(
          `Sorting: ${preferredLangStreams.length} streams with preferred language and ${otherStreams.length} other streams`
        );

        // Sort each group by quality and size
        const sortByQualityAndSize = (a: Stream, b: Stream) => {
          // Extract quality info
          const aDesc = a.description?.split('\n') || [];
          const bDesc = b.description?.split('\n') || [];
          const aQuality = a.name?.includes('\n') ? a.name.split('\n')[1] : '';
          const bQuality = b.name?.includes('\n') ? b.name.split('\n')[1] : '';

          // Get quality scores with improved 4K detection
          const getQualityScore = (quality: string): number => {
            if (!quality) return 0;

            // Standardize the quality string for comparison
            const q = quality.toUpperCase();

            // Check for 4K indicators (multiple ways to indicate 4K)
            if (
              q.includes('4K') ||
              q.includes('2160P') ||
              q.includes('UHD') ||
              q.includes('2160') ||
              q.includes('ULTRA HD')
            )
              return 4;

            // Check for 1080p
            if (q.includes('1080P') || q.includes('1080')) return 3;

            // Check for 720p
            if (q.includes('720P') || q.includes('720')) return 2;

            // Check for 480p/SD
            if (q.includes('480P') || q.includes('480') || q.includes('SD')) return 1;

            return 0;
          };
          const aScore = getQualityScore(aQuality);
          const bScore = getQualityScore(bQuality);

          // Compare quality scores
          if (aScore !== bScore) {
            return bScore - aScore;
          }

          // Compare sizes
          const aSize = aDesc.length > 2 ? aDesc[2] : '';
          const bSize = bDesc.length > 2 ? bDesc[2] : '';

          if (aSize.includes('GB') && bSize.includes('GB')) {
            const aGB = parseFloat(aSize.match(/[\d.]+/)?.[0] || '0');
            const bGB = parseFloat(bSize.match(/[\d.]+/)?.[0] || '0');
            if (aGB > bGB) return -1;
            if (aGB < bGB) return 1;
          }

          if (aSize.includes('GB') && bSize.includes('MB')) return -1;
          if (aSize.includes('MB') && bSize.includes('GB')) return 1;

          if (aSize.includes('MB') && bSize.includes('MB')) {
            const aMB = parseFloat(aSize.match(/[\d.]+/)?.[0] || '0');
            const bMB = parseFloat(bSize.match(/[\d.]+/)?.[0] || '0');
            if (aMB > bMB) return -1;
            if (aMB < bMB) return 1;
          }

          return 0;
        };

        // Sort each group independently
        preferredLangStreams.sort(sortByQualityAndSize);
        otherStreams.sort(sortByQualityAndSize);

        // Replace streams array with the concatenated sorted groups
        streams.length = 0;
        streams.push(...preferredLangStreams, ...otherStreams);
      } else {
        // Original sorting for other preferences
        streams.sort((a, b) => {
          // Extract stream data
          const aFile = (a as any)._temp?.file;
          const bFile = (b as any)._temp?.file;
          const aHasPreferredLang = preferredLang && aFile?.alangs?.includes(preferredLang);
          const bHasPreferredLang = preferredLang && bFile?.alangs?.includes(preferredLang);

          // Extract quality info
          const aDesc = a.description?.split('\n') || [];
          const bDesc = b.description?.split('\n') || [];
          const aQuality = a.name?.includes('\n') ? a.name.split('\n')[1] : '';
          const bQuality = b.name?.includes('\n') ? b.name.split('\n')[1] : '';

          // Get quality scores with improved 4K detection
          const getQualityScore = (quality: string): number => {
            if (!quality) return 0;

            // Standardize the quality string for comparison
            const q = quality.toUpperCase();

            // Check for 4K indicators (multiple ways to indicate 4K)
            if (
              q.includes('4K') ||
              q.includes('2160P') ||
              q.includes('UHD') ||
              q.includes('2160') ||
              q.includes('ULTRA HD')
            )
              return 4;

            // Check for 1080p
            if (q.includes('1080P') || q.includes('1080')) return 3;

            // Check for 720p
            if (q.includes('720P') || q.includes('720')) return 2;

            // Check for 480p/SD
            if (q.includes('480P') || q.includes('480') || q.includes('SD')) return 1;

            return 0;
          };
          const aScore = getQualityScore(aQuality);
          const bScore = getQualityScore(bQuality);

          // Size comparison logic
          const compareSize = () => {
            const aSize = aDesc.length > 2 ? aDesc[2] : '';
            const bSize = bDesc.length > 2 ? bDesc[2] : '';

            if (aSize.includes('GB') && bSize.includes('GB')) {
              const aGB = parseFloat(aSize.match(/[\d.]+/)?.[0] || '0');
              const bGB = parseFloat(bSize.match(/[\d.]+/)?.[0] || '0');
              if (aGB > bGB) return -1;
              if (aGB < bGB) return 1;
            }

            if (aSize.includes('GB') && bSize.includes('MB')) return -1;
            if (aSize.includes('MB') && bSize.includes('GB')) return 1;

            if (aSize.includes('MB') && bSize.includes('MB')) {
              const aMB = parseFloat(aSize.match(/[\d.]+/)?.[0] || '0');
              const bMB = parseFloat(bSize.match(/[\d.]+/)?.[0] || '0');
              if (aMB > bMB) return -1;
              if (aMB < bMB) return 1;
            }

            return 0;
          };

          // Apply sorting based on user preference
          switch (sortingPreference) {
            case 'size_first':
              // Size first, then quality, then language
              const sizeCompare = compareSize();
              if (sizeCompare !== 0) {
                return sizeCompare;
              }
              if (aScore !== bScore) {
                return bScore - aScore;
              }
              if (aHasPreferredLang !== bHasPreferredLang) {
                return aHasPreferredLang ? -1 : 1;
              }
              return 0;

            case 'date_first':
              // Sort by date first using the file's date info
              const aDate = aFile?.['5'] ? new Date(aFile['5']).getTime() : 0;
              const bDate = bFile?.['5'] ? new Date(bFile['5']).getTime() : 0;
              if (aDate !== bDate) {
                // Higher date value (more recent) comes first - descending order
                return bDate - aDate;
              }
              // Then quality
              if (aScore !== bScore) {
                return bScore - aScore;
              }
              // Then language
              if (aHasPreferredLang !== bHasPreferredLang) {
                return aHasPreferredLang ? -1 : 1;
              }
              // Then size
              return compareSize();

            case 'lang_first':
            case 'language_first':
              // Language first, then quality, then size
              if (aHasPreferredLang !== bHasPreferredLang) {
                return aHasPreferredLang ? -1 : 1;
              }
              if (aScore !== bScore) {
                return bScore - aScore;
              }
              return compareSize();

            case 'quality_first':
            default:
              // Quality first (default), then language, then size
              // Make sure the quality score comparison is working
              if (aScore !== bScore) {
                // Higher quality score first - ensure descending order
                return bScore - aScore;
              }
              // Then language
              if (aHasPreferredLang !== bHasPreferredLang) {
                return aHasPreferredLang ? -1 : 1;
              }
              // Then size
              return compareSize();
          }
        });
      }
      logger.debug(
        `Sorting complete. Stream count: ${streams.length} (was ${streamCountBeforeSort})`
      );

      if (streams.length > 0) {
        const qualitySummary: Record<string, number> = {};
        streams.forEach(stream => {
          const quality = stream.name?.split('\n')[1] || 'Unknown';
          qualitySummary[quality] = (qualitySummary[quality] || 0) + 1;
        });

        const qualitySummaryStr = Object.entries(qualitySummary)
          .map(([quality, count]) => `${quality}: ${count}`)
          .join(', ');

        logger.info(`Found ${streams.length} streams total for ${id} (${qualitySummaryStr})`);
      } else {
        logger.info(`Found 0 streams total for ${id}`);
      }

      // Cache the result
      setCache(cacheKey, { streams, ...getCacheOptions(streams.length) });

      return { streams };
    } catch (error) {
      logError({
        message: `failed to handle stream: ${error}`,
        error,
        context: { resource: 'stream', id, type },
      });

      // Check if the error is related to authentication
      if (isAuthError(error)) return authErrorStream(config.preferredLanguage || '');

      return { streams: [] };
    } finally {
      currentUsername = undefined; // Reset username at the end of the handler
      setUtilsUsername(undefined); // Reset utils username
    }
  }
);

function mapStream({
  username,
  password,
  duration,
  size,
  fullResolution,
  title,
  fileExtension,
  videoSize,
  url,
  file,
  preferredLang,
}: {
  title: string;
  url: string;
  username: string;
  password: string;
  fileExtension: string;
  videoSize: number | undefined;
  duration: string | undefined;
  size: string | undefined;
  fullResolution: string | undefined;
  file: any;
  preferredLang: string;
}): Stream {
  logger.debug(`Mapping stream: "${title}" (${fileExtension}, ${size}, ${duration})`);

  const quality = getQuality(title, fullResolution);

  // Log language information for debugging
  if (file.alangs && file.alangs.length > 0) {
    logger.debug(`Stream "${title}" has languages: ${JSON.stringify(file.alangs)}`);
  } else {
    logger.debug(`Stream "${title}" has no language information`);
  }

  // Calculate days since upload
  const publishDate = getPublishDate(file.ts);

  // Show language information in the description if available
  const languageInfo = file.alangs?.length
    ? `🌐 ${file.alangs.join(', ')}${preferredLang && file.alangs.includes(preferredLang) ? ' ⭐' : ''}`
    : '🌐 Unknown';

  const stream: Stream & { _temp?: any } = {
    name: `Easynews++${quality ? `\n${quality}` : ''}`,
    description: [
      `${title}${fileExtension}`,
      `🕛 ${duration ?? 'unknown duration'}`,
      `📦 ${size ?? 'unknown size'} ${publishDate}`,
      languageInfo,
    ].join('\n'),
    url: url,
    behaviorHints: {
      notWebReady: true,
      filename: `${title}${fileExtension}`,
    },
    // Add temporary property with file data for sorting
    _temp: { file },
  };

  return stream;
}

/**
 * Calculate a human-readable publish date from timestamp
 * @param timestamp Unix timestamp in seconds
 * @returns Formatted date string or empty string if timestamp is invalid
 */
function getPublishDate(timestamp: number): string {
  if (!timestamp) return '';

  const uploadDate = new Date(timestamp * 1000);
  const now = new Date();

  // Calculate days difference
  const diffTime = Math.abs(now.getTime() - uploadDate.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return `📅 ${diffDays}d`;
}

function getCacheOptions(itemsLength: number): Partial<Cache> {
  return {
    cacheMaxAge: (Math.min(itemsLength, 10) / 10) * 3600 * 24 * 7, // up to 1 week of cache for items
  };
}

export const addonInterface = builder.getInterface();
