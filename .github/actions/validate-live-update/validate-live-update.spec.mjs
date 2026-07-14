import { describe, expect, it } from 'vitest';
import {
  assertTagCompatible,
  buildOutputLines,
  compareRelease,
  expectedBuildPrefix,
  nativeDependencies,
  parseArgs,
  parseReleaseTag,
  parseTag,
  readNativeVersions,
  releaseOrder,
  selectPreviousTag,
} from './validate-live-update.mjs';

const gradle = (version, build) => `android {\n  defaultConfig {\n    versionCode ${build}\n    versionName "${version}"\n  }\n}`;
const pbxproj = (version, build) => `MARKETING_VERSION = ${version};\nCURRENT_PROJECT_VERSION = ${build};`;

describe('parseArgs', () => {
  it('reads --key value pairs into a map', () => {
    const args = parseArgs(['--app-path', 'app', '--tag', 'v9.0.0']);
    expect(args.get('--app-path')).toBe('app');
    expect(args.get('--tag')).toBe('v9.0.0');
  });
});

describe('tag parsing', () => {
  it('parses bare versions with optional prerelease', () => {
    expect(parseTag('9.0.0')?.slice(1, 5)).toEqual(['9', '0', '0', undefined]);
    expect(parseTag('9.0.0-3')?.[4]).toBe('3');
    expect(parseTag('v9.0.0')).toBeNull();
    expect(parseTag('9.0')).toBeNull();
  });

  it('parses release tags with the v prefix', () => {
    expect(parseReleaseTag('v9.0.0')?.slice(1, 4)).toEqual(['9', '0', '0']);
    expect(parseReleaseTag('9.0.0')).toBeNull();
  });
});

describe('release ordering', () => {
  it('sorts a stable release after its prereleases', () => {
    const stable = parseReleaseTag('v9.0.1');
    const prerelease = parseReleaseTag('v9.0.1-2');
    expect(releaseOrder(stable)[3]).toBe(Number.MAX_SAFE_INTEGER);
    expect(compareRelease(stable, prerelease)).toBeGreaterThan(0);
    expect(compareRelease(prerelease, stable)).toBeLessThan(0);
  });

  it('compares by major, minor then patch', () => {
    expect(compareRelease(parseReleaseTag('v9.1.0'), parseReleaseTag('v9.0.9'))).toBeGreaterThan(0);
    expect(compareRelease(parseReleaseTag('v9.0.0'), parseReleaseTag('v9.0.0'))).toBe(0);
  });
});

describe('readNativeVersions', () => {
  it('returns matching android/ios versions and build numbers', () => {
    const result = readNativeVersions(gradle('9.0.0', '9000000'), pbxproj('9.0.0', '9000000'));
    expect(result.androidVersion.slice(1).join('.')).toBe('9.0.0');
    expect(result.androidBuild).toBe('9000000');
  });

  it('throws when native versions disagree', () => {
    expect(() => readNativeVersions(gradle('9.0.0', '9000000'), pbxproj('9.0.1', '9000000'))).toThrow(/must match/);
  });

  it('throws when build numbers disagree', () => {
    expect(() => readNativeVersions(gradle('9.0.0', '9000000'), pbxproj('9.0.0', '9000001'))).toThrow(/must match/);
  });

  it('throws when a value cannot be read', () => {
    expect(() => readNativeVersions('nothing here', pbxproj('9.0.0', '9000000'))).toThrow(/Unable to read/);
  });
});

describe('assertTagCompatible', () => {
  const androidVersion = /versionName\s+"(\d+)\.(\d+)\.(\d+)"/.exec(gradle('9.0.0', '9000000'));

  it('accepts a matching tag with a correctly encoded build number', () => {
    expect(() => assertTagCompatible(parseTag('9.0.0'), androidVersion, '9000000')).not.toThrow();
    expect(() => assertTagCompatible(parseTag('9.0.5'), androidVersion, '9000000')).not.toThrow();
  });

  it('rejects a tag on a different major/minor', () => {
    expect(() => assertTagCompatible(parseTag('9.1.0'), androidVersion, '9000000')).toThrow(/not compatible/);
  });

  it('rejects a patch below the native patch', () => {
    const native = /versionName\s+"(\d+)\.(\d+)\.(\d+)"/.exec(gradle('9.0.3', '9000000'));
    expect(() => assertTagCompatible(parseTag('9.0.2'), native, '9000000')).toThrow(/not compatible/);
  });

  it('rejects a build number that does not encode major/minor', () => {
    expect(() => assertTagCompatible(parseTag('9.0.0'), androidVersion, '9100000')).toThrow(/does not encode/);
  });
});

describe('expectedBuildPrefix', () => {
  it('encodes major * 100 + minor', () => {
    expect(expectedBuildPrefix('9', '0')).toBe(900);
    expect(expectedBuildPrefix('9', '12')).toBe(912);
  });
});

describe('selectPreviousTag', () => {
  const tags = ['v9.0.0', 'v9.0.1', 'v9.0.2-1', 'v9.0.2', 'v9.1.0', 'v8.9.9'];
  const context = (overrides = {}) => ({
    tag: '9.0.2',
    match: parseTag('9.0.2'),
    major: '9',
    minor: '0',
    containsAppPackage: () => true,
    ...overrides,
  });

  it('returns the newest earlier release on the same major.minor', () => {
    expect(selectPreviousTag(tags, context())).toBe('v9.0.2-1');
  });

  it('excludes the current tag and other minors', () => {
    expect(selectPreviousTag(tags, context({ tag: '9.0.1', match: parseTag('9.0.1') }))).toBe('v9.0.0');
  });

  it('skips tags whose history lacks the app package', () => {
    const containsAppPackage = (candidate) => candidate !== 'v9.0.2-1';
    expect(selectPreviousTag(tags, context({ containsAppPackage }))).toBe('v9.0.1');
  });

  it('returns undefined when there is no earlier compatible tag', () => {
    expect(selectPreviousTag(['v9.0.0', 'v9.1.0'], context({ tag: '9.0.0', match: parseTag('9.0.0') }))).toBeUndefined();
  });
});

describe('nativeDependencies', () => {
  it('keeps only capacitor and live update packages', () => {
    const result = nativeDependencies({
      dependencies: { '@capacitor/core': '8.0.0', '@capawesome/capacitor-live-update': '8.0.0', '@angular/core': '20.0.0' },
      devDependencies: { '@capacitor/cli': '8.0.0', vitest: '3.0.0' },
    });
    expect(result).toEqual({
      '@capacitor/core': '8.0.0',
      '@capawesome/capacitor-live-update': '8.0.0',
      '@capacitor/cli': '8.0.0',
    });
  });
});

describe('buildOutputLines', () => {
  it('emits version, build number and production channel', () => {
    expect(buildOutputLines('9.0.0', '9000000')).toEqual([
      'version=9.0.0',
      'build_number=9000000',
      'production_channel=production-9000000',
    ]);
  });
});
