import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EasynewsAPI } from '../src/api';

// Mock the fetch function
vi.mock('node:fetch', () => ({
  default: vi.fn(),
}));

// Mock the shared package logger
const mockLoggerInstance = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('easynews-plus-plus-shared', () => {
  // This factory is hoisted.
  // It returns an object where createLogger is a new spy.
  return {
    createLogger: vi.fn(() => {
      // Reset spies on the shared instance for "freshness"
      // Using mockReset to clear calls, instances, and mock implementation.
      mockLoggerInstance.debug.mockReset();
      mockLoggerInstance.info.mockReset();
      mockLoggerInstance.warn.mockReset();
      mockLoggerInstance.error.mockReset();
      return mockLoggerInstance;
    }),
    // If other named exports from 'easynews-plus-plus-shared' were used by api.ts,
    // they would need to be mocked here as well. For example:
    // anotherExport: vi.fn(),
  };
});

describe('EasynewsAPI', () => {
  let api: EasynewsAPI;
  let importedMockCreateLogger: ReturnType<typeof vi.fn>; // To store the imported mock

  beforeEach(async () => {
    // beforeEach needs to be async for await import
    // It's important to reset all mocks BEFORE doing anything else,
    // especially before any code that might use the mocked modules is run.
    vi.resetAllMocks();

    // Dynamically import the mocked createLogger HERE, after resetAllMocks
    // and after vi.mock has definitely run.
    // The createLogger function we get here IS the vi.fn() from the mock factory.
    const shared = await import('easynews-plus-plus-shared');
    importedMockCreateLogger = shared.createLogger;

    // Create a new API instance for each test.
    // This will call the (mocked) createLogger.
    api = new EasynewsAPI({
      username: 'test-user',
      password: 'test-password',
    });

    // Assertions on the imported mock
    expect(importedMockCreateLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: 'API',
        username: 'test-user',
      })
    );
  });

  afterEach(() => {
    // vi.resetAllMocks() in beforeEach should cover this.
    // If specific clear down is needed beyond resetting call history etc. it can be done here.
    vi.clearAllMocks();
  });

  it('should throw error when options are missing', () => {
    // @ts-expect-error Testing invalid constructor
    expect(() => new EasynewsAPI()).toThrow('Missing options');
  });

  it('should throw error when query is missing', async () => {
    await expect(api.search({ query: '' })).rejects.toThrow('Query parameter is required');
  });

  it('should handle authentication failure', async () => {
    // Mock fetch to return 401 status
    global.fetch = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      statusText: 'Unauthorized',
    });

    await expect(api.search({ query: 'test' })).rejects.toThrow('Authentication failed');
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.stringContaining('Authentication failed for user: test-user')
    );
  });

  it('should handle API error', async () => {
    // Mock fetch to return 500 status
    global.fetch = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      statusText: 'Internal Server Error',
    });

    await expect(api.search({ query: 'test' })).rejects.toThrow('Failed to fetch search results');
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Request failed with status: 500 Internal Server Error for query: "test"'
      )
    );
  });

  it('should handle network timeout', async () => {
    // Mock fetch to throw AbortError
    global.fetch = vi.fn().mockImplementation(() => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    });

    await expect(api.search({ query: 'test' })).rejects.toThrow('timed out');
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.stringContaining('Search request timed out for: "test"')
    );
  });

  it('should return search results successfully', async () => {
    // Mock successful search response with minimal data
    const mockResponse = {
      data: [],
      results: 0,
      returned: 0,
      unfilteredResults: 0,
    };

    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await api.search({ query: 'test' });
    expect(result).toEqual(mockResponse);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockLoggerInstance.debug).toHaveBeenCalledWith(
      expect.stringContaining('Received 0 results out of 0 total for query: "test"')
    );
    expect(mockLoggerInstance.debug).toHaveBeenCalledWith(
      expect.stringContaining('Caching 0 results for key:')
    );
  });

  it('should use cache for identical searches', async () => {
    // Mock successful search response with minimal data
    const mockResponse = {
      data: [],
      results: 0,
      returned: 0,
      unfilteredResults: 0,
    };

    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    // First search should make API call
    await api.search({ query: 'test' });
    // Second identical search should use cache
    await api.search({ query: 'test' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockLoggerInstance.debug).toHaveBeenCalledWith(
      expect.stringContaining('Cache hit for key:')
    );
  });

  it('should call search at least once for searchAll', async () => {
    // Create a simplified test for searchAll
    const searchSpy = vi.spyOn(api, 'search');

    // Set up a mock response with a successful result
    const mockResponse = {
      data: [{ '0': '1', '1': 'test1.mp4' }], // Minimal data to simulate results
      results: 1,
      returned: 1,
      unfilteredResults: 1,
      // Add any other required properties here if needed
    };

    // Mock implementation for search to return the mock response
    searchSpy.mockResolvedValue(mockResponse as any);

    // Set environment variables for testing
    process.env.TOTAL_MAX_RESULTS = '10';
    process.env.MAX_PAGES = '2';
    process.env.MAX_RESULTS_PER_PAGE = '5';

    // Call searchAll
    await api.searchAll({ query: 'test' });

    // Should have called search at least once
    expect(searchSpy).toHaveBeenCalled();
    expect(searchSpy.mock.calls.length).toBeGreaterThan(0);

    // Clean up environment variables
    delete process.env.TOTAL_MAX_RESULTS;
    delete process.env.MAX_PAGES;
    delete process.env.MAX_RESULTS_PER_PAGE;
  });
});
