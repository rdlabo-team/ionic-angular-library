import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const TAG_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/;
const RELEASE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/;
const NATIVE_PATHS = ['android', 'ios', 'capacitor.config.ts', 'capacitor.config.json'];

export function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1]);
  return args;
}

export function parseTag(tag) {
  return TAG_PATTERN.exec(tag);
}

export function parseReleaseTag(tag) {
  return RELEASE_TAG_PATTERN.exec(tag);
}

export function releaseOrder([, major, minor, patch, prerelease]) {
  return [Number(major), Number(minor), Number(patch), prerelease === undefined ? Number.MAX_SAFE_INTEGER : Number(prerelease)];
}

export function compareRelease(left, right) {
  const leftOrder = releaseOrder(left);
  const rightOrder = releaseOrder(right);
  for (let index = 0; index < leftOrder.length; index += 1) {
    if (leftOrder[index] !== rightOrder[index]) return leftOrder[index] - rightOrder[index];
  }
  return 0;
}

export function selectPreviousTag(tags, { currentTag, currentMatch, containsAppPackage }) {
  return tags
    .filter((candidate) => candidate !== `v${currentTag}`)
    .map((candidate) => ({ candidate, match: parseReleaseTag(candidate) }))
    .filter(({ match }) => match && compareRelease(match, currentMatch) < 0)
    .filter(({ candidate }) => containsAppPackage(candidate))
    .sort((left, right) => compareRelease(right.match, left.match))[0]?.candidate;
}

export function readNativeVersions(androidText, iosText) {
  const androidVersion = /versionName\s+["'](\d+)\.(\d+)\.(\d+)["']/.exec(androidText);
  const androidBuild = /versionCode\s+(\d+)/.exec(androidText)?.[1];
  const iosVersion = /MARKETING_VERSION\s*=\s*(\d+)\.(\d+)\.(\d+);/.exec(iosText);
  const iosBuild = /CURRENT_PROJECT_VERSION\s*=\s*(\d+);/.exec(iosText)?.[1];
  if (!androidVersion || !androidBuild || !iosVersion || !iosBuild) {
    throw new Error('Unable to read Android and iOS native versions/build numbers.');
  }

  const androidMarketingVersion = androidVersion.slice(1).join('.');
  const iosMarketingVersion = iosVersion.slice(1).join('.');
  if (androidMarketingVersion !== iosMarketingVersion || androidBuild !== iosBuild) {
    throw new Error('Android and iOS native versions/build numbers must match.');
  }
  return { marketingVersion: androidMarketingVersion, buildNumber: androidBuild };
}

export function expectedBuildPrefix(major, minor) {
  return Number(major) * 100 + Number(minor);
}

export function assertBuildEncodesVersion(buildNumber, major, minor) {
  if (Math.floor(Number(buildNumber) / 10000) !== expectedBuildPrefix(major, minor)) {
    throw new Error(`Native build number ${buildNumber} does not encode major/minor ${major}.${minor}.`);
  }
}

export function nativeDependencies(packageJson) {
  return Object.fromEntries(
    Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })
      .filter(([name]) => name.includes('capacitor'))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function hasNativeDependencyChanges(previousPackage, currentPackage) {
  return JSON.stringify(nativeDependencies(previousPackage)) !== JSON.stringify(nativeDependencies(currentPackage));
}

export function classifyRelease({
  tagMatch,
  native,
  previousTag,
  previousMatch,
  previousNative,
  nativeFilesChanged = [],
  nativeDependencyChanges = false,
}) {
  const [, major, minor, patch] = tagMatch;
  assertBuildEncodesVersion(native.buildNumber, major, minor);

  const sameMajorMinor = previousMatch?.[1] === major && previousMatch?.[2] === minor;
  if (!previousTag || !sameMajorMinor) {
    const tagMarketingVersion = `${major}.${minor}.${patch}`;
    if (native.marketingVersion !== tagMarketingVersion) {
      throw new Error(`Store release ${tagMarketingVersion} must match native marketing version ${native.marketingVersion}.`);
    }
    if (previousNative && Number(native.buildNumber) <= Number(previousNative.buildNumber)) {
      throw new Error(
        `Store release must increment the native build number above ${previousNative.buildNumber}; got ${native.buildNumber}.`,
      );
    }
    return 'store';
  }

  if (nativeDependencyChanges || nativeFilesChanged.length > 0) {
    const reasons = [...(nativeDependencyChanges ? ['Capacitor/native dependency changes'] : []), ...nativeFilesChanged];
    throw new Error(
      `Patch/prerelease tags cannot contain native changes; bump the major or minor version for a store release:\n${reasons.join('\n')}`,
    );
  }

  const [nativeMajor, nativeMinor, nativePatch] = native.marketingVersion.split('.').map(Number);
  if (Number(major) !== nativeMajor || Number(minor) !== nativeMinor || Number(patch) < nativePatch) {
    throw new Error(`Live Update tag ${tagMatch[0]} is not compatible with native ${native.marketingVersion}.`);
  }
  return 'live-update';
}

export function buildOutputLines(releaseKind, version, buildNumber) {
  return [
    `release_kind=${releaseKind}`,
    `version=${version}`,
    `build_number=${buildNumber}`,
    `production_channel=production-${buildNumber}`,
  ];
}

function gitShow(path, tag) {
  return execFileSync('git', ['show', `${tag}:${path}`], { encoding: 'utf8' });
}

export function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  const appPath = (args.get('--app-path') ?? 'app').replace(/^\.\//, '').replace(/\/$/, '');
  const version = args.get('--tag')?.replace(/^v/, '');
  if (!version) throw new Error('A release tag is required.');
  const tagMatch = parseTag(version);
  if (!tagMatch) throw new Error(`Invalid release tag: ${version}`);

  if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true') {
    throw new Error('Release classification requires complete Git history. Use actions/checkout with fetch-depth: 0.');
  }

  const native = readNativeVersions(
    readFileSync(`${appPath}/android/app/build.gradle`, 'utf8'),
    readFileSync(`${appPath}/ios/App/App.xcodeproj/project.pbxproj`, 'utf8'),
  );
  const tagsText = execFileSync('git', ['tag', '--merged', 'HEAD'], { encoding: 'utf8' }).trim();
  const tags = tagsText ? tagsText.split('\n') : [];
  const containsAppPackage = (candidate) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${candidate}:${appPath}/package.json`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const previousTag = selectPreviousTag(tags, { currentTag: version, currentMatch: tagMatch, containsAppPackage });
  const previousMatch = previousTag ? parseReleaseTag(previousTag) : undefined;

  let previousNative;
  let nativeDependencyChanges = false;
  let nativeFilesChanged = [];
  if (previousTag) {
    const previousPackage = JSON.parse(gitShow(`${appPath}/package.json`, previousTag));
    const currentPackage = JSON.parse(readFileSync(`${appPath}/package.json`, 'utf8'));
    nativeDependencyChanges = hasNativeDependencyChanges(previousPackage, currentPackage);
    nativeFilesChanged = execFileSync(
      'git',
      ['diff', '--name-only', previousTag, 'HEAD', '--', ...NATIVE_PATHS.map((path) => `:(top)${appPath}/${path}`)],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    try {
      previousNative = readNativeVersions(
        gitShow(`${appPath}/android/app/build.gradle`, previousTag),
        gitShow(`${appPath}/ios/App/App.xcodeproj/project.pbxproj`, previousTag),
      );
    } catch (error) {
      if (previousMatch?.[1] === tagMatch[1] && previousMatch?.[2] === tagMatch[2]) throw error;
    }
  }

  const releaseKind = classifyRelease({
    tagMatch,
    native,
    previousTag,
    previousMatch,
    previousNative,
    nativeFilesChanged,
    nativeDependencyChanges,
  });
  const lines = buildOutputLines(releaseKind, version, native.buildNumber);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  console.log(`Classified v${version} as ${releaseKind} for native ${native.marketingVersion} (${native.buildNumber}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
