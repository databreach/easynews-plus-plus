import { extractDigits, getAlternativeTitles, sanitizeTitle } from './utils';
import { createLogger } from 'easynews-plus-plus-shared';
import { ISO_TO_LANGUAGE, ADDITIONAL_LANGUAGE_CODES } from './i18n';

export const logger = createLogger({
  prefix: 'Meta', // Module name
  level: process.env.EASYNEWS_LOG_LEVEL || undefined,
});

export type MetaProviderResponse = {
  name: string;
  originalName?: string; // Original name before any custom titles
  alternativeNames?: string[]; // Alternative names/custom titles
  year?: number;
  season?: string;
  episode?: string;
  tmdbId?: string | null; // Add TMDB ID for fetching translations
  type?: string;
};

// API Key for TMDB - should be added to environment variables in a production app
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

// Flag to indicate if TMDB integration should be used
let useTMDB = true;

if (!TMDB_API_KEY) {
  logger.warn('TMDB_API_KEY is not set. TMDB integration for translated titles will be disabled.');
  useTMDB = false;
}

/**
 * Converts ISO 639-2 language code (used in Stremio) to ISO 639-1 (used by TMDB)
 * @param langCode ISO 639-2 language code
 * @returns ISO 639-1 language code or original code if no mapping exists
 */
function convertToTMDBLanguageCode(langCode: string): string {
  // First check our standard language map from i18n
  if (ISO_TO_LANGUAGE[langCode]) {
    return ISO_TO_LANGUAGE[langCode];
  }

  // Then check additional languages not used in the UI
  if (ADDITIONAL_LANGUAGE_CODES[langCode]) {
    return ADDITIONAL_LANGUAGE_CODES[langCode];
  }

  // Return original if no mapping exists
  return langCode;
}

/**
 * Fetches translated title for a movie or TV show from TMDB
 * @param imdbId IMDb ID
 * @param preferredLanguage Preferred language code (ISO 639-2 format like 'ger', 'fre', etc.)
 * @returns The translated title if available, or null if not found
 */
async function getTMDBTranslatedTitle(
  imdbId: string,
  preferredLanguage: string
): Promise<string | null> {
  // Skip if TMDB integration is disabled or no language preference
  if (!useTMDB || !preferredLanguage || preferredLanguage === '') {
    return null;
  }

  // Convert language code to ISO 639-1 for TMDB API
  const tmdbLangCode = convertToTMDBLanguageCode(preferredLanguage);
  logger.debug(
    `Converting language code from ${preferredLanguage} to TMDB format: ${tmdbLangCode}`
  );

  try {
    // First, we need to find the TMDB ID from the IMDb ID
    logger.debug(`Fetching TMDB 'find' data for IMDb ID: ${imdbId}`);
    const findResponse = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
    );

    if (!findResponse.ok) {
      const errorText = await findResponse.text();
      logger.error(`TMDB API error: ${findResponse.status} - ${errorText}`);

      // Disable TMDB for future requests if API key is invalid
      if (findResponse.status === 401) {
        logger.error('TMDB API key is invalid. Disabling TMDB integration.');
        useTMDB = false;
      }
      return null;
    }

    const findData = await findResponse.json();

    // Check if we found a movie or TV show
    const isMovie = findData.movie_results && findData.movie_results.length > 0;
    const isTVShow = findData.tv_results && findData.tv_results.length > 0;

    if (!isMovie && !isTVShow) {
      logger.info(`No TMDB entry found for IMDb ID: ${imdbId}`);
      return null;
    }

    // Get the TMDB ID
    const tmdbId = isMovie ? findData.movie_results[0].id : findData.tv_results[0].id;

    // Now fetch the details in the preferred language
    const detailsUrl = isMovie
      ? `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=${tmdbLangCode}`
      : `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=${tmdbLangCode}`;

    if (isMovie) {
      logger.debug(
        `Fetching TMDB movie details for TMDB ID: ${tmdbId}, Lang: ${tmdbLangCode || 'default'}`
      );
    } else {
      logger.debug(
        `Fetching TMDB TV details for TMDB ID: ${tmdbId}, Lang: ${tmdbLangCode || 'default'}`
      );
    }
    const detailsResponse = await fetch(detailsUrl);

    if (!detailsResponse.ok) {
      logger.error(`TMDB API details error: ${detailsResponse.status}`);
      return null;
    }

    const detailsData = await detailsResponse.json();

    // If the title is available in the preferred language, return it
    if (detailsData.title) {
      const translatedTitle = detailsData.title;
      logger.debug(`Found translated title for ${imdbId} in ${tmdbLangCode}: ${translatedTitle}`);
      return translatedTitle;
    } else if (detailsData.name) {
      // For TV shows
      const translatedTitle = detailsData.name;
      logger.debug(`Found translated title for ${imdbId} in ${tmdbLangCode}: ${translatedTitle}`);
      return translatedTitle;
    }

    // If we couldn't get a translation from movie/show details, try fetching translations explicitly
    const translationsUrl = isMovie
      ? `https://api.themoviedb.org/3/movie/${tmdbId}/translations?api_key=${TMDB_API_KEY}`
      : `https://api.themoviedb.org/3/tv/${tmdbId}/translations?api_key=${TMDB_API_KEY}`;

    if (isMovie) {
      logger.debug(`Fetching TMDB movie translations for TMDB ID: ${tmdbId}`);
    } else {
      logger.debug(`Fetching TMDB TV translations for TMDB ID: ${tmdbId}`);
    }
    const translationsResponse = await fetch(translationsUrl);

    if (!translationsResponse.ok) {
      logger.error(`TMDB API translations error: ${translationsResponse.status}`);
      return null;
    }

    const translationsData = await translationsResponse.json();

    // Look for the translation in the preferred language
    const translation = translationsData.translations?.find(
      (t: any) => t.iso_639_1 === tmdbLangCode
    );

    if (translation) {
      const translatedTitle = isMovie ? translation.data.title : translation.data.name;

      if (translatedTitle) {
        logger.debug(
          `Found translated title from translations endpoint for ${imdbId} in ${tmdbLangCode}: ${translatedTitle}`
        );
        return translatedTitle;
      }
    }

    logger.info(`No translation found for ${imdbId} in ${tmdbLangCode}`);
    return null;
  } catch (error) {
    logger.error(`Error fetching TMDB translation for ${imdbId}: ${error}`);
    return null;
  }
}

async function imdbMetaProvider(
  id: string,
  preferredLanguage?: string
): Promise<MetaProviderResponse> {
  var [tt, season, episode] = id.split(':');

  logger.debug(`Fetching IMDb metadata for ID: ${tt}`);
  return fetch(`https://v2.sg.media-imdb.com/suggestion/t/${tt}.json`)
    .then(res => res.json())
    .then(json => {
      return json.d.find((item: { id: string }) => item.id === tt);
    })
    .then(async ({ l, y }) => {
      // Get original name and potential custom titles
      const originalName = l;
      const alternativeNames = getAlternativeTitles(originalName);

      // Variable to store the actual TMDB ID if we can retrieve it
      let tmdbId: string | null = null;

      // If preferred language is provided, try to get a translated title
      if (preferredLanguage && preferredLanguage !== '') {
        const translatedTitle = await getTMDBTranslatedTitle(tt, preferredLanguage);
        if (translatedTitle) {
          // Add both original translated title and sanitized version
          if (!alternativeNames.includes(translatedTitle)) {
            alternativeNames.push(translatedTitle);
            logger.info(`Added TMDB translated title: ${translatedTitle}`);
          }

          // Add sanitized version for search matching
          const sanitizedTitle = sanitizeTitle(translatedTitle);
          if (sanitizedTitle !== translatedTitle && !alternativeNames.includes(sanitizedTitle)) {
            alternativeNames.push(sanitizedTitle);
            logger.info(`Added sanitized TMDB title: ${sanitizedTitle}`);
          }

          // Try to get the actual TMDB ID
          tmdbId = await getTMDBId(tt);
        }
      } else if (useTMDB) {
        // Even if we don't need translations, try to get the TMDB ID if TMDB is enabled
        tmdbId = await getTMDBId(tt);
      }

      return {
        name: originalName,
        originalName,
        alternativeNames,
        year: y,
        season,
        episode,
        tmdbId, // Use the actual TMDB ID if available
      };
    });
}

/**
 * Helper function to get TMDB ID from IMDb ID
 */
async function getTMDBId(imdbId: string): Promise<string | null> {
  if (!useTMDB) {
    return null;
  }

  try {
    logger.debug(`Fetching TMDB 'find' data for IMDb ID: ${imdbId}`); // Already added in getTMDBTranslatedTitle, but good to have if called directly
    const findResponse = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
    );

    if (!findResponse.ok) {
      logger.error(`TMDB API error: ${findResponse.status}`);
      return null;
    }

    const findData = await findResponse.json();

    // Check if we found a movie or TV show
    const isMovie = findData.movie_results && findData.movie_results.length > 0;
    const isTVShow = findData.tv_results && findData.tv_results.length > 0;

    if (!isMovie && !isTVShow) {
      return null;
    }

    // Get the TMDB ID
    const tmdbId = isMovie ? findData.movie_results[0].id : findData.tv_results[0].id;
    return tmdbId.toString();
  } catch (error) {
    logger.error(`Error fetching TMDB ID for ${imdbId}: ${error}`);
    return null;
  }
}

async function cinemetaMetaProvider(
  id: string,
  type: string,
  preferredLanguage?: string
): Promise<MetaProviderResponse> {
  var [tt, season, episode] = id.split(':');

  logger.debug(`Fetching Cinemeta metadata for ID: ${tt}, Type: ${type}`);
  return fetch(`https://v3-cinemeta.strem.io/meta/${type}/${tt}.json`)
    .then(res => res.json())
    .then(json => {
      const meta = json.meta;
      const name = meta.name;
      const year = extractDigits(meta.year ?? meta.releaseInfo);

      // Get original name and potential custom titles
      const originalName = name;
      const alternativeNames = getAlternativeTitles(originalName);

      // Variable to store the actual TMDB ID if we can retrieve it
      let tmdbId: string | null = null;

      // If preferred language is provided, try to get a translated title
      if (preferredLanguage && preferredLanguage !== '') {
        return getTMDBTranslatedTitle(tt, preferredLanguage).then(async translatedTitle => {
          if (translatedTitle) {
            // Add both original translated title and sanitized version
            if (!alternativeNames.includes(translatedTitle)) {
              alternativeNames.push(translatedTitle);
              logger.info(`Added TMDB translated title: ${translatedTitle}`);
            }

            // Add sanitized version for search matching
            const sanitizedTitle = sanitizeTitle(translatedTitle);
            if (sanitizedTitle !== translatedTitle && !alternativeNames.includes(sanitizedTitle)) {
              alternativeNames.push(sanitizedTitle);
              logger.debug(`Added sanitized TMDB title: ${sanitizedTitle}`);
            }

            // Try to get the actual TMDB ID
            tmdbId = await getTMDBId(tt);
          } else if (useTMDB) {
            // Even if we don't need translations, try to get the TMDB ID if TMDB is enabled
            tmdbId = await getTMDBId(tt);
          }

          return {
            name,
            originalName,
            alternativeNames,
            year,
            episode,
            season,
            tmdbId, // Use the actual TMDB ID if available
          } satisfies MetaProviderResponse;
        });
      }

      // If no language preference, still try to get TMDB ID if enabled
      if (useTMDB) {
        return getTMDBId(tt).then(id => {
          return {
            name,
            originalName,
            alternativeNames,
            year,
            episode,
            season,
            tmdbId: id, // Use the actual TMDB ID if available
          } satisfies MetaProviderResponse;
        });
      }

      return {
        name,
        originalName,
        alternativeNames,
        year,
        episode,
        season,
        tmdbId: null,
      } satisfies MetaProviderResponse;
    });
}

/**
 * Fetches metadata from IMDB and use Cinemeta as a fallback.
 */
export async function publicMetaProvider(
  id: string,
  type: string,
  preferredLanguage?: string
): Promise<MetaProviderResponse> {
  return imdbMetaProvider(id, preferredLanguage)
    .then(meta => {
      if (meta.name) {
        logger.debug(`Successfully fetched metadata from IMDb for ID: ${id}`);
        return meta;
      }
      logger.debug(`IMDb lookup failed for ID: ${id}, falling back to Cinemeta.`);
      return cinemetaMetaProvider(id, type, preferredLanguage);
    })
    .then(meta => {
      // This block will execute for both successful IMDb and successful Cinemeta (after fallback)
      // We need to ensure we only log Cinemeta success if it was actually called after an IMDb fail.
      // The previous log for IMDb success handles the direct IMDb case.
      // If meta.name is truthy here, and we fell back, it means Cinemeta succeeded.
      if (meta.name && !meta.originalName?.startsWith('IMDb#')) {
        // Crude check: if originalName isn't clearly IMDb's, assume Cinemeta if we got here via fallback
        // A more robust way would be to check a flag or if the previous meta.name was null
        // For now, this will log if cinemeta was the one to provide the name.
        // The original log for IMDb success already covers the primary IMDb case.
      }

      if (meta.name) {
        // If we are here, and the original IMDb call didn't return meta.name (logged failure before cinemeta call),
        // then this success is from Cinemeta.
        // The check for `meta.name` is sufficient as the error is thrown otherwise.
        // The previous `logger.debug(\`IMDb lookup failed for ID: \${id}, falling back to Cinemeta.\`);`
        // already signals that Cinemeta was attempted. So a simple success here implies Cinemeta.
        // Let's assume the first log in the chain `Successfully fetched metadata from IMDb for ID: ${id}`
        // only runs if IMDb was successful.
        // If that one didn't run, and this one has meta.name, it must be Cinemeta.
        // This is a bit indirect. A clearer way would be separate .then() for cinemeta.

        // The current structure makes it hard to distinguish if this .then() is after
        // a successful IMDb or a successful Cinemeta fallback.
        // The previous `logger.debug` for IMDb success handles that case.
        // The `logger.debug` for IMDb failure + fallback to Cinemeta is also there.
        // So, if we reach here and `meta.name` is present, it means *some* provider succeeded.
        // The specific "Cinemeta success" log is implicitly covered if IMDb failed and this has data.
        return meta;
      }
      // This specific block might be redundant if the only goal is to log Cinemeta success *after fallback*.
      // The structure means this .then() is always called.

      throw new Error('Failed to find metadata');
    });
}
