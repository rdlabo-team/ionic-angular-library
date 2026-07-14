import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

export const CLI_PACKAGE = '@capawesome/cli';
export const DEFAULT_CLI_VERSION = '4.15.0';
export const PRIVATE_KEY_FILE = 'private.pem';

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

const cli = (cliVersion) => `${CLI_PACKAGE}@${cliVersion}`;

export function bundleArgs({ cliVersion, inputPath, outputPath }) {
  return [cli(cliVersion), 'apps:liveupdates:bundle', '--input-path', inputPath, '--output-path', outputPath, '--overwrite'];
}

export function loginArgs({ cliVersion, token }) {
  return [cli(cliVersion), 'login', '--token', token];
}

export function channelCreateArgs({ cliVersion, appId, channel }) {
  return [cli(cliVersion), 'apps:channels:create', '--app-id', appId, '--name', channel, '--ignore-errors'];
}

export function uploadArgs({ cliVersion, appId, channel, bundlePath, privateKeyPath, buildNumber, gitRef, version, rolloutPercentage }) {
  return [
    cli(cliVersion),
    'apps:liveupdates:upload',
    '--app-id',
    appId,
    '--channel',
    channel,
    '--path',
    bundlePath,
    '--private-key',
    privateKeyPath,
    '--android-min',
    String(buildNumber),
    '--android-max',
    String(buildNumber),
    '--ios-min',
    String(buildNumber),
    '--ios-max',
    String(buildNumber),
    '--git-ref',
    gitRef,
    '--custom-property',
    `version=${version}`,
    '--rollout-percentage',
    String(rolloutPercentage),
    '--yes',
  ];
}

/**
 * Resolve options from parsed CLI args and the environment. Secrets are read from
 * the environment only (composite actions forward them through inputs → env).
 */
export function resolveOptions(args, env = {}) {
  const options = {
    appPath: args.get('--app-path') ?? 'app',
    appId: args.get('--app-id') ?? env.CAPAWESOME_APP_ID,
    channel: args.get('--channel'),
    buildNumber: args.get('--build-number'),
    version: (args.get('--version') ?? '').replace(/^v/, ''),
    gitRef: args.get('--git-ref') ?? env.GITHUB_SHA,
    cliVersion: args.get('--cli-version') ?? DEFAULT_CLI_VERSION,
    inputPath: args.get('--input-path') ?? 'www/browser',
    bundlePath: args.get('--bundle-path') ?? 'bundle.zip',
    rolloutPercentage: args.get('--rollout-percentage') ?? '100',
    token: env.CAPAWESOME_TOKEN,
    privateKey: env.CAPAWESOME_LIVE_UPDATE_PRIVATE_KEY,
  };

  const required = {
    'app-id': options.appId,
    channel: options.channel,
    'build-number': options.buildNumber,
    version: options.version,
    'git-ref': options.gitRef,
    CAPAWESOME_TOKEN: options.token,
    CAPAWESOME_LIVE_UPDATE_PRIVATE_KEY: options.privateKey,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) throw new Error(`Missing required inputs: ${missing.join(', ')}`);

  return options;
}

function defaultRun(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

/**
 * Bundle the web build, authenticate, ensure the channel exists and upload the
 * signed Live Update. I/O is injectable so the flow can be unit tested.
 */
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  run = defaultRun,
  chdir = process.chdir,
  writeKey = (path, key) => writeFileSync(path, key),
  removeKey = (path) => rmSync(path, { force: true }),
} = {}) {
  const options = resolveOptions(parseArgs(argv), env);
  chdir(options.appPath);

  run('npx', bundleArgs(options));
  run('npx', loginArgs({ cliVersion: options.cliVersion, token: options.token }));

  writeKey(PRIVATE_KEY_FILE, options.privateKey);
  try {
    run('npx', channelCreateArgs(options));
    run('npx', uploadArgs({ ...options, privateKeyPath: PRIVATE_KEY_FILE }));
  } finally {
    removeKey(PRIVATE_KEY_FILE);
  }

  console.log(`Published Live Update ${options.version} to ${options.channel} (build ${options.buildNumber}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
