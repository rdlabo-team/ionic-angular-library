import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const TAG_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/;
const RELEASE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/;

/**
 * Parse `--key value` pairs from an argv slice (already stripped of node/script).
 */
export function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    args.set(argv[index], argv[index + 1]);
  }
  return args;
}

/** Match a bare version (no leading v). Returns the RegExp match or null. */
export function parseTag(tag) {
  return TAG_PATTERN.exec(tag);
}

/** Match a release tag (with leading v). Returns the RegExp match or null. */
export function parseReleaseTag(candidate) {
  return RELEASE_TAG_PATTERN.exec(candidate);
}

/** Sortable tuple for a version match; a missing prerelease sorts last (stable release). */
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

/** Read native version/build info from the raw gradle and pbxproj file contents. */
export function readNativeVersions(androidText, iosText) {
  const androidVersion = /versionName\s+"(\d+)\.(\d+)\.(\d+)"/.exec(androidText);
  const androidBuild = /versionCode\s+(\d+)/.exec(androidText)?.[1];
  const iosVersion = /MARKETING_VERSION = (\d+)\.(\d+)\.(\d+);/.exec(iosText);
  const iosBuild = /CURRENT_PROJECT_VERSION = (\d+);/.exec(iosText)?.[1];
  if (!androidVersion || !androidBuild || !iosVersion || !iosBuild) throw new Error('Unable to read native versions.');
  if (androidVersion.slice(1).join('.') !== iosVersion.slice(1).join('.') || androidBuild !== iosBuild) {
    throw new Error('Android and iOS native versions/build numbers must match.');
  }
  return { androidVersion, androidBuild, iosVersion, iosBuild };
}

export function expectedBuildPrefix(major, minor) {
  return Number(major) * 100 + Number(minor);
}

/** Ensure the release tag matches the native marketing version and encoded build number. */
export function assertTagCompatible(match, androidVersion, androidBuild) {
  const [, major, minor, patch] = match;
  if (major !== androidVersion[1] || minor !== androidVersion[2] || Number(patch) < Number(androidVersion[3])) {
    throw new Error(`Tag v${match[0]} is not compatible with native ${androidVersion.slice(1).join('.')}.`);
  }
  if (Math.floor(Number(androidBuild) / 10000) !== expectedBuildPrefix(major, minor)) {
    throw new Error(`Native build number ${androidBuild} does not encode major/minor ${major}.${minor}.`);
  }
}

/**
 * Pick the most recent release tag on the same major.minor that predates the current
 * release and still carries the app package (git history is provided via callbacks).
 */
export function selectPreviousTag(tags, { tag, match, major, minor, containsAppPackage }) {
  const compatible = tags
    .filter((candidate) => candidate !== `v${tag}`)
    .map((candidate) => ({ candidate, match: parseReleaseTag(candidate) }))
    .filter(({ match: candidate }) => candidate?.[1] === major && candidate?.[2] === minor && compareRelease(candidate, match) < 0)
    .filter(({ candidate }) => containsAppPackage(candidate))
    .sort((a, b) => compareRelease(b.match, a.match));
  return compatible[0]?.candidate;
}

/** Extract the Capacitor / Live Update native dependencies that force a store release when changed. */
export function nativeDependencies(packageJson) {
  return Object.fromEntries(
    Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies }).filter(
      ([name]) => name.startsWith('@capacitor/') || name === '@capawesome/capacitor-live-update',
    ),
  );
}

export function buildOutputLines(tag, androidBuild) {
  return [`version=${tag}`, `build_number=${androidBuild}`, `production_channel=production-${androidBuild}`];
}

export function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  const appPath = args.get('--app-path') ?? 'app';
  const repoAppPath = appPath.replace(/^\.\//, '').replace(/\/$/, '');
  const tag = args.get('--tag')?.replace(/^v/, '');
  if (!tag) throw new Error('A release tag is required.');
  process.chdir(appPath);

  if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true') {
    throw new Error('Live Update validation requires the complete Git history. Use actions/checkout with fetch-depth: 0.');
  }

  const match = parseTag(tag);
  if (!match) throw new Error(`Invalid live update tag: ${tag}`);
  const [, major, minor] = match;

  const { androidVersion, androidBuild } = readNativeVersions(
    readFileSync('android/app/build.gradle', 'utf8'),
    readFileSync('ios/App/App.xcodeproj/project.pbxproj', 'utf8'),
  );
  assertTagCompatible(match, androidVersion, androidBuild);

  const tags = execFileSync('git', ['tag', '--merged', 'HEAD'], { encoding: 'utf8' }).trim().split('\n');
  const containsAppPackage = (candidate) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${candidate}:${repoAppPath}/package.json`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const previousTag = selectPreviousTag(tags, { tag, match, major, minor, containsAppPackage });

  if (previousTag) {
    const previousPackage = JSON.parse(execFileSync('git', ['show', `${previousTag}:${repoAppPath}/package.json`], { encoding: 'utf8' }));
    const currentPackage = JSON.parse(readFileSync('package.json', 'utf8'));
    if (JSON.stringify(nativeDependencies(previousPackage)) !== JSON.stringify(nativeDependencies(currentPackage))) {
      throw new Error('Capacitor plugin dependency changes require a store release.');
    }
    const changed = execFileSync(
      'git',
      [
        'diff',
        '--name-only',
        previousTag,
        'HEAD',
        '--',
        `:(top)${repoAppPath}/android`,
        `:(top)${repoAppPath}/ios`,
        `:(top)${repoAppPath}/capacitor.config.ts`,
        `:(top)${repoAppPath}/capacitor.config.json`,
      ],
      { encoding: 'utf8' },
    ).trim();
    if (changed) throw new Error(`Native changes require a store release:\n${changed}`);
  }

  const output = env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `${buildOutputLines(tag, androidBuild).join('\n')}\n`);
  console.log(`Validated v${tag} for native ${androidVersion.slice(1).join('.')} (${androidBuild}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
