import { describe, expect, it, vi, beforeEach } from 'vitest';
// Other imports like manifest should come after mocks if they use mocked modules,
// or be explicitly listed after the vi.mock calls for them.

// Mocking needs to happen before imports that use these modules.

vi.mock('../src/manifest', () => ({
  manifest: {
    id: 'org.easynews',
    name: 'Easynews++',
    description: 'Easynews++ Addon',
    version: '1.0.0',
    resources: ['stream'],
    types: ['movie', 'series'],
  },
}));

// Import manifest after its mock is defined.
import { manifest } from '../src/manifest';

// Import after mock for checking calls
import { publicMetaProvider as mockPublicMetaProviderSpy } from '../src/meta';
import {
  buildSearchQuery as mockBuildSearchQuery,
  getAlternativeTitles as mockGetAlternativeTitlesSpy,
  getPostTitle as mockGetPostTitleSpy,
  getFileExtension as mockGetFileExtensionSpy,
  getSize as mockGetSizeSpy,
  getDuration as mockGetDurationSpy,
  getQuality as mockGetQualitySpy,
  matchesTitle as mockMatchesTitleSpy,
  isBadVideo as mockIsBadVideoSpy,
  createStreamUrl as mockCreateStreamUrlSpy, // Import for createStreamUrl
  createStreamPath as mockCreateStreamPathSpy, // Import for createStreamPath (might need it too)
} from '../src/utils';

vi.mock('../src/utils', () => ({
  buildSearchQuery: vi.fn().mockImplementation((type, meta) => {
    return `${meta.name} ${meta.year || ''}`.trim();
  }),
  createStreamPath: vi.fn(), // Will be configured in beforeEach
  createStreamUrl: vi.fn(), // Will be configured in beforeEach
  getDuration: vi.fn(),
  getFileExtension: vi.fn(),
  getPostTitle: vi.fn(),
  getQuality: vi.fn().mockReturnValue('1080p'), // Static for now
  getSize: vi.fn(), // Will be configured in beforeEach
  isBadVideo: vi.fn(), // Will be configured in beforeEach
  logError: vi.fn(),
  matchesTitle: vi.fn(), // Will be configured in beforeEach
  getAlternativeTitles: vi.fn(), // Will be configured in beforeEach
  isAuthError: vi.fn().mockReturnValue(false),
  setUtilsUsername: vi.fn(),
}));

// Define a variable to hold the mock search method spy
let mockApiSearchMethodSpy: ReturnType<typeof vi.fn>;

// Define the mock data for API search response
const mockApiSearchData = {
  data: [
    {
      '0': 'file-hash-real-1',
      '10': 'Test Movie Title From API Result',
      '11': '.mkv',
      '4': '2048MB',
      ts: Math.floor(Date.now() / 1000) - 2 * 86400, // Changed key '5' to 'ts'
      fullres: '1920x1080',
      alangs: ['eng', 'spa'],
      rawSize: 2048 * 1024 * 1024,
      type: 'VIDEO',
      passwd: false,
      virus: false,
    },
  ],
  results: 1,
  returned: 1,
  unfilteredResults: 1,
  downURL: 'https://members.easynews.com/dl/',
  dlFarm: 'farm-abc',
  dlPort: '80',
};

vi.mock('easynews-plus-plus-api', () => ({
  EasynewsAPI: vi.fn().mockImplementation(() => {
    mockApiSearchMethodSpy = vi.fn().mockResolvedValue(mockApiSearchData);
    return {
      search: mockApiSearchMethodSpy,
    };
  }),
}));

// Import the mocked constructor to re-apply implementation in beforeEach
import { EasynewsAPI as MockedEasynewsAPIConstructor } from 'easynews-plus-plus-api';

vi.mock('../src/meta', () => ({
  publicMetaProvider: vi.fn().mockResolvedValue({
    id: 'tt1234567',
    name: 'Test Movie',
    year: 2023,
    type: 'movie',
  }),
}));

vi.mock('../src/i18n', () => ({
  getUILanguage: vi.fn().mockReturnValue('en'), // Ensure this returns 'en'
  translations: {
    en: {
      // Ensure the key is 'en'
      errors: {
        authFailed:
          'Authentication Failed: Invalid username or password\nCheck your credentials & reconfigure addon',
      },
    },
  },
}));

vi.mock('stremio-addon-sdk/src/builder', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      defineStreamHandler: vi.fn().mockImplementation(handler => {
        (global as any).streamHandler = handler;
        return handler;
      }),
      getInterface: vi.fn().mockReturnValue({
        manifest, // manifest is imported after its mock now
        stream: {
          handler: (global as any).streamHandler,
        },
      }),
    })),
  };
});

vi.mock('easynews-plus-plus-shared', () => {
  // These spies are lexically scoped *inside* the factory.
  const loggerSpies = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const createLoggerMock = vi.fn(() => {
    // When createLogger is called by SUT, reset these lexically captured spies.
    loggerSpies.debug.mockReset();
    loggerSpies.info.mockReset();
    loggerSpies.warn.mockReset();
    loggerSpies.error.mockReset();
    return loggerSpies;
  });

  return {
    createLogger: createLoggerMock,
    // Export the spies directly from the mock so tests can access them.
    __internalLoggerSpies: loggerSpies,
  };
});

// Mock custom-titles.json
vi.mock('../../../custom-titles.json', () => ({
  default: {
    'Test Movie': ['Test Movie Alt', 'Another Test Title'],
  },
}));

// Mock custom-template
vi.mock('../src/custom-template', () => ({
  default: vi.fn().mockReturnValue('<html>Mocked template</html>'),
}));

// Now import the tested module after all mocks are set up
import { addonInterface, landingHTML } from '../src/addon';
// Import the mocked functions to assert the initial call.
// This import must happen *after* vi.mock is defined and *after* addon SUT is imported.
import {
  createLogger as actualCreateLoggerFromMock,
  __internalLoggerSpies as actualLoggerSpiesFromMock,
} from 'easynews-plus-plus-shared';

// Assert the initial module-level call to createLogger from addon.ts
// This happens once when addon.ts is imported.
expect(actualCreateLoggerFromMock).toHaveBeenCalledWith(
  expect.objectContaining({
    prefix: 'Addon',
    username: expect.any(Function),
  })
);
// Optionally, check if it was called exactly once if that's the expectation for module init
expect(actualCreateLoggerFromMock).toHaveBeenCalledTimes(1);

describe('Addon', () => {
  // loggerSpiesFromMock will be used in tests to check for logger.warn, logger.debug etc.
  // It's the same object as actualLoggerSpiesFromMock initially.
  // Its methods (vi.fn spies) will be reset by vi.resetAllMocks() in beforeEach.
  const loggerSpiesFromMock = actualLoggerSpiesFromMock;

  beforeEach(() => {
    vi.resetAllMocks();

    mockPublicMetaProviderSpy.mockResolvedValue({
      id: 'tt1234567',
      name: 'Test Movie',
      year: 2023,
      type: 'movie',
    });

    mockGetAlternativeTitlesSpy.mockReturnValue(['Alternative Title']);

    mockBuildSearchQuery.mockImplementation((type: any, meta: any) => {
      return `${meta.name} ${meta.year || ''}`.trim();
    });

    // Dynamic mocks for file utility functions
    mockGetPostTitleSpy.mockImplementation((file: any) => file['10'] || 'Default Mock Title');
    mockGetFileExtensionSpy.mockImplementation((file: any) => file['11'] || '.err');
    mockGetSizeSpy.mockImplementation((file: any) => file['4'] || '0MB');
    // mockGetDurationSpy.mockReturnValue('120m'); // Keep static or make dynamic if needed
    // mockGetQualitySpy.mockReturnValue('1080p'); // Keep static or make dynamic if needed

    mockMatchesTitleSpy.mockReturnValue(true); // Ensure it's permissive
    mockIsBadVideoSpy.mockReturnValue(false); // Ensure it's permissive
    mockGetQualitySpy.mockReturnValue('1080p');
    mockGetDurationSpy.mockReturnValue('120m');
    mockCreateStreamUrlSpy.mockReturnValue('https://easynews.com/stream'); // Re-establish createStreamUrl
    mockCreateStreamPathSpy.mockReturnValue('path/to/stream'); // Re-establish createStreamPath

    // Re-establish the implementation for the EasynewsAPI constructor mock
    (MockedEasynewsAPIConstructor as ReturnType<typeof vi.fn>).mockImplementation(() => {
      mockApiSearchMethodSpy = vi.fn().mockResolvedValue(mockApiSearchData);
      return { search: mockApiSearchMethodSpy };
    });
  });

  it('should export addonInterface', () => {
    expect(addonInterface).toBeDefined();
    expect(addonInterface.manifest).toEqual(manifest); // manifest is imported after its mock
  });

  it('should export landingHTML', () => {
    expect(landingHTML).toBeDefined();
    expect(landingHTML).toBe('<html>Mocked template</html>');
  });

  it('should handle stream request with valid credentials', async () => {
    const streamHandler = (global as any).streamHandler;
    expect(streamHandler).toBeDefined();

    const result = await streamHandler({
      id: 'tt1234567',
      type: 'movie',
      config: { username: 'testuser', password: 'testpass' },
    });

    expect(result).toHaveProperty('streams');
    expect(Array.isArray(result.streams)).toBe(true);

    // --- Assertions for initial logger calls & mock interactions ---
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('Stream handler invoked for id: tt1234567')
    );
    expect(mockPublicMetaProviderSpy).toHaveBeenCalled();
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('Fetched metadata for "Test Movie"')
    );
    expect(loggerSpiesFromMock.info).toHaveBeenCalledWith(
      expect.stringContaining('Searching for: Test Movie')
    );

    // Assertions for allTitles generation logs
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('Getting alternative titles for: Test Movie')
    );
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('Initial allTitles count: 1, first: Test Movie')
    );
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('Adding direct custom titles for "Test Movie"')
    );
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('allTitles after direct custom count: 3, first: Test Movie')
    );
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('Adding 1 additional titles from partial matches')
    );
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('allTitles after partial matches count: 4, first: Test Movie')
    );
    expect(loggerSpiesFromMock.info).toHaveBeenCalledWith(
      expect.stringContaining('Final list of titles to search for (4)')
    ); // Assuming 4 titles based on mocks

    // Assertions for mock function calls that lead to API interaction
    expect(mockGetAlternativeTitlesSpy).toHaveBeenCalled();
    expect(mockBuildSearchQuery).toHaveBeenCalled();
    expect(mockApiSearchMethodSpy).toHaveBeenCalled();

    // --- Assertions for logs after API call and during stream processing ---
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('Cache miss for key:')
    );
    // The query "Test Movie 2023" is built if meta.year is present. Our meta mock has year 2023.
    // The log in addon.ts is "Found X results for "${query}" without year" or "Found X results for "${query}" with year"
    // Our current mock searches both with and without year. The first call to buildSearchQuery is without year.
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('Found 1 results for "Test Movie" without year')
    );

    // Assertions for stream mapping (assuming one stream is mapped from mock data)
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('Mapping stream: "Test Movie Title From API Result" (.mkv, 2048MB,')
    );
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        'Stream "Test Movie Title From API Result" has languages: ["eng","spa"]'
      )
    );

    // --- Assertions for final stream results ---
    expect(result.streams.length).toBeGreaterThan(0);
    const stream = result.streams[0];
    expect(stream).toHaveProperty('name');
    expect(stream.name).toContain('Easynews++');
    expect(stream.name).toContain('1080p'); // Based on getQuality mock (static '1080p') and file.fullres ('1920x1080')

    expect(stream).toHaveProperty('description');
    expect(stream.description).toContain('Test Movie Title From API Result.mkv'); // From dynamic getPostTitle & getFileExtension
    expect(stream.description).toContain('2048MB'); // From dynamic getSize using file['4']
    expect(stream.description).toContain('eng, spa'); // Languages from API data
    expect(stream.description).toMatch(/📅 \dd/); // Publish date format

    expect(stream).toHaveProperty('url', 'https://easynews.com/stream'); // From createStreamUrl mock

    // --- Assertions for final logging (filtering, sorting, final count) ---
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringMatching(/Starting filters with \d+ streams/)
    );
    expect(loggerSpiesFromMock.info).toHaveBeenCalledWith(
      expect.stringMatching(/Filtering complete: \d+ streams → \d+ streams/)
    );
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringMatching(/Preparing to sort \d+ streams/)
    );
    expect(loggerSpiesFromMock.debug).toHaveBeenCalledWith(
      expect.stringMatching(/Sorting complete\. Stream count: \d+/)
    );
    expect(loggerSpiesFromMock.info).toHaveBeenCalledWith(
      expect.stringMatching(/Found 1 streams total for tt1234567/)
    );
  });

  it('should handle stream request with missing credentials', async () => {
    const streamHandler = (global as any).streamHandler;

    const result = await streamHandler({
      id: 'tt1234567',
      type: 'movie',
      config: { username: '', password: '' },
    });

    expect(result).toHaveProperty('streams');
    expect(Array.isArray(result.streams)).toBe(true);
    expect(result.streams.length).toBe(1);
    expect(result.streams[0].name).toBe('Easynews++ Auth Error');
    expect(result.streams[0].description).toBe(
      'Authentication Failed: Invalid username or password\nCheck your credentials & reconfigure addon'
    );
    expect(loggerSpiesFromMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('User configuration is incomplete')
    );
  });

  it('should handle non-IMDb IDs', async () => {
    // Get the stream handler
    const streamHandler = (global as any).streamHandler;

    // Call the handler with a non-IMDb ID
    const result = await streamHandler({
      id: 'kitsu:1234567',
      type: 'movie',
      config: {
        username: 'testuser',
        password: 'testpass',
      },
    });

    // Verify empty result
    expect(result).toHaveProperty('streams');
    expect(Array.isArray(result.streams)).toBe(true);
    expect(result.streams.length).toBe(0);
  });

  it('should filter and sort streams based on config', async () => {
    // Get the stream handler
    const streamHandler = (global as any).streamHandler;

    // Call the handler with custom config
    const result = await streamHandler({
      id: 'tt1234567',
      type: 'movie',
      config: {
        username: 'testuser',
        password: 'testpass',
        strictTitleMatching: 'true',
        preferredLanguage: 'eng',
        sortingPreference: 'quality_first',
        showQualities: '1080p',
        maxResultsPerQuality: '3',
        maxFileSize: '2',
      },
    });

    // Verify the result
    expect(result).toHaveProperty('streams');
    expect(Array.isArray(result.streams)).toBe(true);
  });
});
