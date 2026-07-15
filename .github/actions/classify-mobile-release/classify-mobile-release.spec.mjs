import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertBuildEncodesVersion,
  buildOutputLines,
  classifyRelease,
  compareRelease,
  hasNativeDependencyChanges,
  nativeDependencies,
  parseArgs,
  parseReleaseTag,
  parseTag,
  readNativeVersions,
  selectPreviousTag,
} from './classify-mobile-release.mjs';

const gradle = (version, build) => `defaultConfig { versionCode ${build}\nversionName "${version}" }`;
const pbxproj = (version, build) => `MARKETING_VERSION = ${version};\nCURRENT_PROJECT_VERSION = ${build};`;
const match = (version) => parseTag(version);
const releaseMatch = (version) => parseReleaseTag(`v${version}`);
const classification = (overrides = {}) => ({
  tagMatch: match('9.0.1'),
  native: { marketingVersion: '9.0.0', buildNumber: '9000001' },
  previousTag: 'v9.0.0',
  previousMatch: releaseMatch('9.0.0'),
  previousNative: { marketingVersion: '9.0.0', buildNumber: '9000000' },
  nativeFilesChanged: [],
  nativeDependencyChanges: false,
  ...overrides,
});

describe('arguments and tags', () => {
  it('parses action arguments', () => {
    const args = parseArgs(['--app-path', 'app', '--tag', 'v9.1.0']);
    assert.equal(args.get('--app-path'), 'app');
    assert.equal(args.get('--tag'), 'v9.1.0');
  });

  it('accepts only the supported stable and numeric prerelease formats', () => {
    assert.deepEqual(match('9.1.2')?.slice(1), ['9', '1', '2', undefined]);
    assert.deepEqual(match('9.1.2-3')?.slice(1), ['9', '1', '2', '3']);
    assert.equal(match('v9.1.2'), null);
    assert.equal(match('9.1.2-beta.1'), null);
  });

  it('orders prereleases before stable releases and across major/minor', () => {
    assert.ok(compareRelease(releaseMatch('9.1.0'), releaseMatch('9.0.99')) > 0);
    assert.ok(compareRelease(releaseMatch('9.1.1-2'), releaseMatch('9.1.1-1')) > 0);
    assert.ok(compareRelease(releaseMatch('9.1.1'), releaseMatch('9.1.1-2')) > 0);
  });
});

describe('previous release selection', () => {
  const tags = ['not-a-release', 'v8.9.9', 'v9.0.0', 'v9.0.1-1', 'v9.0.1', 'v9.1.0'];

  it('selects the newest earlier applicable release across all major/minor versions', () => {
    assert.equal(
      selectPreviousTag(tags, {
        currentTag: '9.1.0',
        currentMatch: match('9.1.0'),
        containsAppPackage: () => true,
      }),
      'v9.0.1',
    );
  });

  it('skips the current/newer tags and tags that do not contain the app', () => {
    assert.equal(
      selectPreviousTag(tags, {
        currentTag: '9.0.1',
        currentMatch: match('9.0.1'),
        containsAppPackage: (tag) => tag !== 'v9.0.1-1',
      }),
      'v9.0.0',
    );
  });

  it('returns undefined for the first applicable release', () => {
    assert.equal(
      selectPreviousTag(['v9.0.0'], {
        currentTag: '9.0.0',
        currentMatch: match('9.0.0'),
        containsAppPackage: () => true,
      }),
      undefined,
    );
  });
});

describe('native metadata', () => {
  it('reads matching Android/iOS metadata', () => {
    assert.deepEqual(readNativeVersions(gradle('9.2.0', '9020001'), pbxproj('9.2.0', '9020001')), {
      marketingVersion: '9.2.0',
      buildNumber: '9020001',
    });
  });

  it('rejects missing or inconsistent native metadata', () => {
    assert.throws(() => readNativeVersions('', pbxproj('9.2.0', '9020001')), /Unable to read/);
    assert.throws(() => readNativeVersions(gradle('9.2.0', '9020001'), pbxproj('9.2.1', '9020001')), /must match/);
    assert.throws(() => readNativeVersions(gradle('9.2.0', '9020001'), pbxproj('9.2.0', '9020002')), /must match/);
  });

  it('checks the major/minor build-number encoding', () => {
    assert.doesNotThrow(() => assertBuildEncodesVersion('9029999', '9', '2'));
    assert.throws(() => assertBuildEncodesVersion('9030000', '9', '2'), /does not encode/);
  });
});

describe('native dependency detection', () => {
  const previous = {
    dependencies: { '@capacitor/core': '8.0.0', '@angular/core': '21.0.0' },
    devDependencies: { '@rdlabo/capacitor-brotherprint': '8.0.0' },
  };

  it('selects Capacitor core and third-party plugin packages', () => {
    assert.deepEqual(nativeDependencies(previous), {
      '@capacitor/core': '8.0.0',
      '@rdlabo/capacitor-brotherprint': '8.0.0',
    });
  });

  it('detects native dependency additions and version changes but ignores web dependencies', () => {
    assert.equal(hasNativeDependencyChanges(previous, previous), false);
    assert.equal(
      hasNativeDependencyChanges(previous, {
        ...previous,
        dependencies: { ...previous.dependencies, '@angular/core': '21.1.0' },
      }),
      false,
    );
    assert.equal(
      hasNativeDependencyChanges(previous, {
        ...previous,
        devDependencies: { '@rdlabo/capacitor-brotherprint': '8.1.0' },
      }),
      true,
    );
  });
});

describe('release classification', () => {
  it('routes patch, prerelease progression, and stable promotion to Live Update', () => {
    assert.equal(classifyRelease(classification()), 'live-update');
    assert.equal(
      classifyRelease(
        classification({
          tagMatch: match('9.0.2-2'),
          previousTag: 'v9.0.2-1',
          previousMatch: releaseMatch('9.0.2-1'),
        }),
      ),
      'live-update',
    );
    assert.equal(
      classifyRelease(
        classification({
          tagMatch: match('9.0.2'),
          previousTag: 'v9.0.2-3',
          previousMatch: releaseMatch('9.0.2-3'),
        }),
      ),
      'live-update',
    );
  });

  it('routes the first release and major/minor bumps to store publishing', () => {
    assert.equal(
      classifyRelease(
        classification({
          tagMatch: match('9.0.0'),
          native: { marketingVersion: '9.0.0', buildNumber: '9000000' },
          previousTag: undefined,
          previousMatch: undefined,
          previousNative: undefined,
        }),
      ),
      'store',
    );
    assert.equal(
      classifyRelease(
        classification({
          tagMatch: match('9.1.0'),
          native: { marketingVersion: '9.1.0', buildNumber: '9010000' },
        }),
      ),
      'store',
    );
    assert.equal(
      classifyRelease(
        classification({
          tagMatch: match('10.0.0'),
          native: { marketingVersion: '10.0.0', buildNumber: '10000000' },
        }),
      ),
      'store',
    );
  });

  it('requires store tag/native version equality and an increased build number', () => {
    assert.throws(
      () => classifyRelease(classification({ tagMatch: match('9.1.0'), native: { marketingVersion: '9.1.1', buildNumber: '9010000' } })),
      /must match native marketing version/,
    );
    assert.throws(
      () => classifyRelease(classification({ tagMatch: match('9.1.0'), native: { marketingVersion: '9.1.0', buildNumber: '9000000' } })),
      /does not encode/,
    );
    assert.throws(
      () =>
        classifyRelease(
          classification({
            tagMatch: match('9.1.0'),
            native: { marketingVersion: '9.1.0', buildNumber: '9010000' },
            previousNative: { marketingVersion: '9.0.0', buildNumber: '9010000' },
          }),
        ),
      /must increment/,
    );
    assert.throws(
      () =>
        classifyRelease(
          classification({
            tagMatch: match('9.1.0'),
            native: { marketingVersion: '9.1.0', buildNumber: '9010000' },
            previousNative: { marketingVersion: '9.0.0', buildNumber: '9020000' },
          }),
        ),
      /must increment/,
    );
  });

  it('rejects native files or dependency changes on patch/prerelease tags', () => {
    assert.throws(
      () => classifyRelease(classification({ nativeFilesChanged: ['app/ios/App/Podfile'] })),
      /bump the major or minor.*app\/ios\/App\/Podfile/s,
    );
    assert.throws(() => classifyRelease(classification({ nativeDependencyChanges: true })), /Capacitor\/native dependency changes/);
  });

  it('rejects a Live Update below the installed native patch', () => {
    assert.throws(
      () =>
        classifyRelease(
          classification({
            tagMatch: match('9.0.1'),
            native: { marketingVersion: '9.0.2', buildNumber: '9000001' },
          }),
        ),
      /not compatible/,
    );
  });
});

describe('action outputs', () => {
  it('emits the routing and existing Live Update outputs', () => {
    assert.deepEqual(buildOutputLines('live-update', '9.0.1', '9000000'), [
      'release_kind=live-update',
      'version=9.0.1',
      'build_number=9000000',
      'production_channel=production-9000000',
    ]);
  });
});
