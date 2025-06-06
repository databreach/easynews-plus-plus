import { EasynewsSearchResponse, FileData, SearchOptions } from './types';
import { createBasic } from './utils';
import { createLogger, Logger } from 'easynews-plus-plus-shared';

export class EasynewsAPI {
  private readonly logger: Logger;
  private readonly baseUrl = 'https://members.easynews.com';
  private readonly username: string;
  private readonly password: string;
  private readonly cache = new Map<string, { data: EasynewsSearchResponse; timestamp: number }>();
  private readonly cacheTTL = 1000 * 60 * 60 * parseInt(process.env.CACHE_TTL || '24'); // 24 hours

  constructor(options: { username: string; password: string }) {
    if (!options) {
      throw new Error('Missing options');
    }

    this.username = options.username;
    this.password = options.password;
    this.logger = createLogger({
      prefix: 'API',
      level: process.env.EASYNEWS_LOG_LEVEL || undefined,
      username: this.username,
    });
  }

  private getCacheKey(options: SearchOptions): string {
    return JSON.stringify({
      query: options.query,
      pageNr: options.pageNr || 1,
      maxResults: parseInt(process.env.MAX_RESULTS_PER_PAGE || '250'),
      sort1: options.sort1 || 'dsize',
      sort1Direction: options.sort1Direction || '-',
      sort2: options.sort2 || 'relevance',
      sort2Direction: options.sort2Direction || '-',
      sort3: options.sort3 || 'dtime',
      sort3Direction: options.sort3Direction || '-',
    });
  }

  private getFromCache(cacheKey: string): EasynewsSearchResponse | null {
    const cached = this.cache.get(cacheKey);
    if (!cached) {
      this.logger.debug(`Cache miss for key: ${cacheKey.substring(0, 50)}...`);
      return null;
    }

    const now = Date.now();
    if (now - cached.timestamp > this.cacheTTL) {
      this.logger.debug(`Cache expired for key: ${cacheKey.substring(0, 50)}...`);
      this.cache.delete(cacheKey);
      return null;
    }

    this.logger.debug(`Cache hit for key: ${cacheKey.substring(0, 50)}...`);
    return cached.data;
  }

  private setCache(cacheKey: string, data: EasynewsSearchResponse): void {
    this.logger.debug(
      `Caching ${data.data?.length || 0} results for key: ${cacheKey.substring(0, 50)}...`
    );
    this.cache.set(cacheKey, { data, timestamp: Date.now() });
  }

  async search({
    query,
    pageNr = 1,
    maxResults = parseInt(process.env.MAX_RESULTS_PER_PAGE || '250'),
    sort1 = 'dsize',
    sort1Direction = '-',
    sort2 = 'relevance',
    sort2Direction = '-',
    sort3 = 'dtime',
    sort3Direction = '-',
  }: SearchOptions): Promise<EasynewsSearchResponse> {
    if (!query) {
      throw new Error('Query parameter is required');
    }

    this.logger.debug(`Searching for: "${query}" (page ${pageNr}, max ${maxResults})`);

    const cacheKey = this.getCacheKey({
      query,
      pageNr,
      maxResults,
      sort1,
      sort1Direction,
      sort2,
      sort2Direction,
      sort3,
      sort3Direction,
    });

    const cachedResult = this.getFromCache(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }

    const searchParams = {
      st: 'adv',
      sb: '1',
      fex: 'm4v,3gp,mov,divx,xvid,wmv,avi,mpg,mpeg,mp4,mkv,avc,flv,webm',
      'fty[]': 'VIDEO',
      spamf: '1',
      u: '1',
      gx: '1',
      pno: pageNr.toString(),
      sS: '3',
      s1: sort1,
      s1d: sort1Direction,
      s2: sort2,
      s2d: sort2Direction,
      s3: sort3,
      s3d: sort3Direction,
      pby: maxResults.toString(),
      safeO: '0',
      gps: query,
    };

    const url = new URL(`${this.baseUrl}/2.0/search/solr-search/advanced`);
    url.search = new URLSearchParams(searchParams).toString();

    this.logger.debug(`Request URL: ${url.toString().substring(0, 100)}...`);

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: createBasic(this.username, this.password),
        },
        signal: AbortSignal.timeout(20_000), // 20 seconds
      });

      if (res.status === 401) {
        this.logger.warn(`Authentication failed for user: ${this.username}`);
        throw new Error('Authentication failed: Invalid username or password');
      }

      if (!res.ok) {
        this.logger.warn(
          `Request failed with status: ${res.status} ${res.statusText} for query: "${query}"`
        );
        throw new Error(
          `Failed to fetch search results of query '${query}': ${res.status} ${res.statusText}`
        );
      }

      const json = await res.json();
      this.logger.debug(
        `Received ${json.data?.length || 0} results out of ${json.results || 0} total for query: "${query}"`
      );
      this.setCache(cacheKey, json);
      return json;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          this.logger.warn(`Search request timed out for: "${query}"`);
          throw new Error(`Search request for '${query}' timed out after 20 seconds`);
        }
        this.logger.warn(`Error during search for "${query}": ${error.message}`);
        throw error;
      }
      this.logger.error(`Unknown error during search for "${query}"`);
      throw new Error(`Unknown error during search for '${query}'`);
    }
  }

  async searchAll(options: SearchOptions): Promise<EasynewsSearchResponse> {
    this.logger.info(`Starting searchAll for: "${options.query}"`);

    const data: FileData[] = [];
    let res: Partial<EasynewsSearchResponse> = {
      data: [],
      results: 0,
      returned: 0,
      unfilteredResults: 0,
    };

    // Set constants for result limits
    const TOTAL_MAX_RESULTS = parseInt(process.env.TOTAL_MAX_RESULTS || '500'); // Maximum total results to return
    const MAX_PAGES = parseInt(process.env.MAX_PAGES || '10'); // Safety limit on number of page requests
    const MAX_RESULTS_PER_PAGE = parseInt(process.env.MAX_RESULTS_PER_PAGE || '250'); // Maximum results per page

    this.logger.info(
      `Search limits: max ${TOTAL_MAX_RESULTS} results, max ${MAX_PAGES} pages, ${MAX_RESULTS_PER_PAGE} per page for query: "${options.query}"`
    );

    let pageNr = 1;
    let pageCount = 0;

    try {
      while (pageCount < MAX_PAGES) {
        // Calculate optimal page size for each request
        // Always respect TOTAL_MAX_RESULTS even on the first page
        const remainingResults = TOTAL_MAX_RESULTS - data.length;
        const optimalPageSize = Math.min(MAX_RESULTS_PER_PAGE, remainingResults);

        // If we've already reached our limit, stop fetching
        if (remainingResults <= 0) {
          this.logger.debug(
            `Reached result limit (${TOTAL_MAX_RESULTS}), stopping pagination for query: "${options.query}"`
          );
          break;
        }

        this.logger.debug(
          `Fetching page ${pageNr} with ${optimalPageSize} results per page for query: "${options.query}"`
        );
        const pageResult = await this.search({
          ...options,
          pageNr,
          maxResults: optimalPageSize,
        });

        res = pageResult;
        pageCount++;

        const newData = pageResult.data || [];

        // No more results
        if (newData.length === 0) {
          this.logger.info(
            `No more results found, stopping pagination for query: "${options.query}" (page ${pageNr})`
          );
          break;
        }

        // Duplicate detection - stop if first item of new page matches first item of previously fetched data
        if (data.length > 0 && newData[0]?.['0'] === data[0]?.['0']) {
          this.logger.info(
            `Duplicate results detected, stopping pagination for query: "${options.query}" (page ${pageNr})`
          );
          break;
        }

        this.logger.debug(
          `Adding ${newData.length} results from page ${pageNr} for query: "${options.query}"`
        );
        data.push(...newData);

        // Stop if we've reached our total limit
        if (data.length >= TOTAL_MAX_RESULTS) {
          this.logger.info(
            `Reached result limit (${TOTAL_MAX_RESULTS}), trimming and stopping for query: "${options.query}"`
          );
          // Trim the array to exactly TOTAL_MAX_RESULTS
          data.length = TOTAL_MAX_RESULTS;
          break;
        }

        this.logger.debug(
          `Progress for "${options.query}": ${data.length}/${TOTAL_MAX_RESULTS} results (${Math.round(
            (data.length / TOTAL_MAX_RESULTS) * 100
          )}%)`
        );

        pageNr++;
      }

      this.logger.info(
        `SearchAll complete for "${options.query}", returning ${data.length} total results`
      );
      return { ...res, data } as EasynewsSearchResponse;
    } catch (error) {
      // If we have partial results, return them
      if (data.length > 0) {
        this.logger.warn(
          `Returning ${data.length} partial results for query "${options.query}" due to error: ${(error as Error).message}`
        );
        return { ...res, data } as EasynewsSearchResponse;
      }
      this.logger.error(
        `No results to return for query "${options.query}" due to error: ${(error as Error).message}`
      );
      throw error;
    }
  }
}
