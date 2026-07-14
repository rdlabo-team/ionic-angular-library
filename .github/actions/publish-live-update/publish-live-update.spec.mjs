import { describe, expect, it, vi } from 'vitest';
import {
  bundleArgs,
  channelCreateArgs,
  DEFAULT_CLI_VERSION,
  loginArgs,
  main,
  parseArgs,
  PRIVATE_KEY_FILE,
  resolveOptions,
  uploadArgs,
} from './publish-live-update.mjs';

const baseArgv = [
  '--app-path',
  'app',
  '--app-id',
  'app-123',
  '--channel',
  'production-9000000',
  '--build-number',
  '9000000',
  '--version',
  'v9.0.0',
  '--git-ref',
  'deadbeef',
];

const baseEnv = {
  CAPAWESOME_TOKEN: 'token-abc',
  CAPAWESOME_LIVE_UPDATE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----xxx-----END PRIVATE KEY-----',
};

describe('parseArgs', () => {
  it('reads --key value pairs into a map', () => {
    const args = parseArgs(['--app-id', 'x', '--channel', 'y']);
    expect(args.get('--app-id')).toBe('x');
    expect(args.get('--channel')).toBe('y');
  });
});

describe('command builders', () => {
  it('bundleArgs pins the cli version and overwrites', () => {
    expect(bundleArgs({ cliVersion: '4.15.0', inputPath: 'www/browser', outputPath: 'bundle.zip' })).toEqual([
      '@capawesome/cli@4.15.0',
      'apps:liveupdates:bundle',
      '--input-path',
      'www/browser',
      '--output-path',
      'bundle.zip',
      '--overwrite',
    ]);
  });

  it('loginArgs passes the token', () => {
    expect(loginArgs({ cliVersion: '4.15.0', token: 't' })).toEqual(['@capawesome/cli@4.15.0', 'login', '--token', 't']);
  });

  it('channelCreateArgs ignores errors so re-runs are idempotent', () => {
    expect(channelCreateArgs({ cliVersion: '4.15.0', appId: 'a', channel: 'production-1' })).toEqual([
      '@capawesome/cli@4.15.0',
      'apps:channels:create',
      '--app-id',
      'a',
      '--name',
      'production-1',
      '--ignore-errors',
    ]);
  });

  it('uploadArgs pins min/max to the build number and tags the version', () => {
    const args = uploadArgs({
      cliVersion: '4.15.0',
      appId: 'a',
      channel: 'production-9000000',
      bundlePath: 'bundle.zip',
      privateKeyPath: 'private.pem',
      buildNumber: '9000000',
      gitRef: 'deadbeef',
      version: '9.0.0',
      rolloutPercentage: '100',
    });
    expect(args).toContain('apps:liveupdates:upload');
    expect(args).toContain('--yes');
    for (const flag of ['--android-min', '--android-max', '--ios-min', '--ios-max']) {
      expect(args[args.indexOf(flag) + 1]).toBe('9000000');
    }
    expect(args[args.indexOf('--custom-property') + 1]).toBe('version=9.0.0');
    expect(args[args.indexOf('--rollout-percentage') + 1]).toBe('100');
    expect(args[args.indexOf('--private-key') + 1]).toBe('private.pem');
  });
});

describe('resolveOptions', () => {
  it('applies defaults and strips a leading v from the version', () => {
    const options = resolveOptions(parseArgs(baseArgv), baseEnv);
    expect(options.version).toBe('9.0.0');
    expect(options.cliVersion).toBe(DEFAULT_CLI_VERSION);
    expect(options.inputPath).toBe('www/browser');
    expect(options.bundlePath).toBe('bundle.zip');
    expect(options.rolloutPercentage).toBe('100');
    expect(options.token).toBe('token-abc');
  });

  it('falls back to CAPAWESOME_APP_ID and GITHUB_SHA from the environment', () => {
    const argv = ['--channel', 'production-1', '--build-number', '1', '--version', '1.0.0'];
    const env = { ...baseEnv, CAPAWESOME_APP_ID: 'env-app', GITHUB_SHA: 'env-sha' };
    const options = resolveOptions(parseArgs(argv), env);
    expect(options.appId).toBe('env-app');
    expect(options.gitRef).toBe('env-sha');
  });

  it('throws listing every missing required input', () => {
    expect(() => resolveOptions(parseArgs(['--app-path', 'app']), {})).toThrow(/Missing required inputs/);
    try {
      resolveOptions(parseArgs(['--app-path', 'app']), {});
    } catch (error) {
      expect(error.message).toContain('app-id');
      expect(error.message).toContain('channel');
      expect(error.message).toContain('CAPAWESOME_TOKEN');
      expect(error.message).toContain('CAPAWESOME_LIVE_UPDATE_PRIVATE_KEY');
    }
  });
});

describe('main', () => {
  const harness = () => {
    const calls = [];
    return {
      calls,
      deps: {
        argv: baseArgv,
        env: baseEnv,
        run: (command, args) => calls.push({ type: 'run', command, args, subcommand: args[1] }),
        chdir: (path) => calls.push({ type: 'chdir', path }),
        writeKey: (path, key) => calls.push({ type: 'writeKey', path, key }),
        removeKey: (path) => calls.push({ type: 'removeKey', path }),
      },
    };
  };

  it('runs bundle → login → channel → upload in order and cleans up the key', () => {
    const { calls, deps } = harness();
    main(deps);
    const sequence = calls.map((call) => call.type + (call.subcommand ? `:${call.subcommand}` : ''));
    expect(sequence).toEqual([
      'chdir',
      'run:apps:liveupdates:bundle',
      'run:login',
      'writeKey',
      'run:apps:channels:create',
      'run:apps:liveupdates:upload',
      'removeKey',
    ]);
    const bundleCall = calls.find((call) => call.subcommand === 'apps:liveupdates:bundle');
    expect(bundleCall.args[bundleCall.args.indexOf('--output-path') + 1]).toBe('bundle.zip');
    expect(bundleCall.args[bundleCall.args.indexOf('--input-path') + 1]).toBe('www/browser');
    const uploadCall = calls.find((call) => call.subcommand === 'apps:liveupdates:upload');
    expect(uploadCall.args[uploadCall.args.indexOf('--path') + 1]).toBe('bundle.zip');
    expect(calls.find((call) => call.type === 'writeKey').path).toBe(PRIVATE_KEY_FILE);
    expect(calls.find((call) => call.type === 'removeKey').path).toBe(PRIVATE_KEY_FILE);
  });

  it('removes the private key even when the upload fails', () => {
    const { calls, deps } = harness();
    deps.run = (command, args) => {
      calls.push({ type: 'run', subcommand: args[1] });
      if (args[1] === 'apps:liveupdates:upload') throw new Error('upload failed');
    };
    expect(() => main(deps)).toThrow(/upload failed/);
    expect(calls.some((call) => call.type === 'removeKey')).toBe(true);
  });

  it('never writes the private key before authenticating', () => {
    const { calls, deps } = harness();
    main(deps);
    const loginIndex = calls.findIndex((call) => call.subcommand === 'login');
    const writeIndex = calls.findIndex((call) => call.type === 'writeKey');
    expect(loginIndex).toBeLessThan(writeIndex);
  });
});
