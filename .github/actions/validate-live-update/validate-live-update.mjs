import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const appPath = args.get('--app-path') ?? 'app';
const repoAppPath = appPath.replace(/^\.\//, '').replace(/\/$/, '');
const tag = args.get('--tag')?.replace(/^v/, '');
if (!tag) throw new Error('A release tag is required.');
process.chdir(appPath);

if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true') {
  throw new Error('Live Update validation requires the complete Git history. Use actions/checkout with fetch-depth: 0.');
}

const match = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(tag);
if (!match) throw new Error(`Invalid live update tag: ${tag}`);

const android = readFileSync('android/app/build.gradle', 'utf8');
const ios = readFileSync('ios/App/App.xcodeproj/project.pbxproj', 'utf8');
const androidVersion = /versionName\s+"(\d+)\.(\d+)\.(\d+)"/.exec(android);
const androidBuild = /versionCode\s+(\d+)/.exec(android)?.[1];
const iosVersion = /MARKETING_VERSION = (\d+)\.(\d+)\.(\d+);/.exec(ios);
const iosBuild = /CURRENT_PROJECT_VERSION = (\d+);/.exec(ios)?.[1];
if (!androidVersion || !androidBuild || !iosVersion || !iosBuild) throw new Error('Unable to read native versions.');
if (androidVersion.slice(1).join('.') !== iosVersion.slice(1).join('.') || androidBuild !== iosBuild) {
  throw new Error('Android and iOS native versions/build numbers must match.');
}

const [, major, minor, patch] = match;
if (major !== androidVersion[1] || minor !== androidVersion[2] || Number(patch) < Number(androidVersion[3])) {
  throw new Error(`Tag v${tag} is not compatible with native ${androidVersion.slice(1).join('.')}.`);
}
const expectedBuildPrefix = Number(major) * 100 + Number(minor);
if (Math.floor(Number(androidBuild) / 10000) !== expectedBuildPrefix) {
  throw new Error(`Native build number ${androidBuild} does not encode major/minor ${major}.${minor}.`);
}

const tags = execFileSync('git', ['tag', '--merged', 'HEAD'], { encoding: 'utf8' }).trim().split('\n');
const releaseOrder = ([, releaseMajor, releaseMinor, releasePatch, prerelease]) => [
  Number(releaseMajor),
  Number(releaseMinor),
  Number(releasePatch),
  prerelease === undefined ? Number.MAX_SAFE_INTEGER : Number(prerelease),
];
const compareRelease = (left, right) => {
  const leftOrder = releaseOrder(left);
  const rightOrder = releaseOrder(right);
  for (let index = 0; index < leftOrder.length; index += 1) {
    if (leftOrder[index] !== rightOrder[index]) return leftOrder[index] - rightOrder[index];
  }
  return 0;
};
const containsAppPackage = (candidate) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${candidate}:${repoAppPath}/package.json`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const compatible = tags
  .filter((candidate) => candidate !== `v${tag}`)
  .map((candidate) => ({ candidate, match: /^v(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(candidate) }))
  .filter(({ match: candidate }) => candidate?.[1] === major && candidate?.[2] === minor && compareRelease(candidate, match) < 0)
  .filter(({ candidate }) => containsAppPackage(candidate))
  .sort((a, b) => compareRelease(b.match, a.match));

const previousTag = compatible[0]?.candidate;
if (previousTag) {
  const nativeDependencies = (packageJson) =>
    Object.fromEntries(
      Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies }).filter(
        ([name]) => name.startsWith('@capacitor/') || name === '@capawesome/capacitor-live-update',
      ),
    );
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

const output = process.env.GITHUB_OUTPUT;
if (output) {
  const values = [`version=${tag}`, `build_number=${androidBuild}`, `production_channel=production-${androidBuild}`];
  await import('node:fs/promises').then(({ appendFile }) => appendFile(output, `${values.join('\n')}\n`));
}
console.log(`Validated v${tag} for native ${androidVersion.slice(1).join('.')} (${androidBuild}).`);
