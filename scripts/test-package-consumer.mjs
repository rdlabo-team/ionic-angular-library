import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const workspace = process.cwd();
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'ionic-angular-package-consumer-'));
const packageProjects = ['kit', 'photo-editor', 'scroll-header', 'scroll-strategies'];
const commandEnvironment = { ...process.env, npm_config_cache: join(temporaryDirectory, 'npm-cache') };
const installedPackages = new Map();

const installPackedPackage = (project) => {
  const distribution = join(workspace, 'dist', project);
  if (!existsSync(join(distribution, 'package.json'))) {
    throw new Error(`Build output is missing for ${project}. Run npm run prebuild first.`);
  }
  const [{ filename }] = JSON.parse(
    execFileSync('npm', ['pack', distribution, '--json', '--pack-destination', temporaryDirectory], {
      encoding: 'utf8',
      env: commandEnvironment,
    }),
  );
  const manifest = JSON.parse(readFileSync(join(distribution, 'package.json'), 'utf8'));
  const segments = manifest.name.split('/');
  const parent = join(temporaryDirectory, 'node_modules', ...segments.slice(0, -1));
  const target = join(parent, segments.at(-1));
  mkdirSync(parent, { recursive: true });
  execFileSync('tar', ['-xzf', join(temporaryDirectory, filename), '-C', parent]);
  renameSync(join(parent, 'package'), target);
  installedPackages.set(manifest.name, { manifest, target });
};

const exportedModule = (packageName, exportName) => {
  const { manifest, target } = installedPackages.get(packageName);
  const modulePath = manifest.exports?.[exportName]?.default;
  assert.equal(typeof modulePath, 'string', `${packageName} is missing export ${exportName}`);
  return resolve(target, modulePath);
};

const bundlePhotoSurface = async (exportName, forbiddenPackages, requiredImports = []) => {
  const packageName = '@rdlabo/ionic-angular-photo-editor';
  const primaryModule = exportedModule(packageName, '.');
  const observedImports = new Set();
  await build({
    entryPoints: [exportedModule(packageName, exportName)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    nodePaths: [join(workspace, 'node_modules')],
    logLevel: 'silent',
    plugins: [
      {
        name: 'optional-peer-isolation',
        setup(buildContext) {
          buildContext.onResolve({ filter: /.*/ }, ({ path }) => {
            if (forbiddenPackages.includes(path)) {
              throw new Error(`${exportName} has a static dependency on optional peer ${path}`);
            }
            if (requiredImports.includes(path)) {
              observedImports.add(path);
              return undefined;
            }
            if (path === packageName) {
              return { path: primaryModule };
            }
            if (!path.startsWith('.') && !path.startsWith('/')) {
              return { path, external: true };
            }
            return undefined;
          });
        },
      },
    ],
  });
  assert.deepEqual([...observedImports].sort(), [...requiredImports].sort(), `${exportName} must use literal adapter imports`);
};

try {
  packageProjects.forEach(installPackedPackage);

  const photoManifest = installedPackages.get('@rdlabo/ionic-angular-photo-editor').manifest;
  for (const dependency of ['@angular/forms', 'ionicons', 'rxjs']) {
    assert.equal(typeof photoManifest.peerDependencies?.[dependency], 'string', `Missing runtime peer ${dependency}`);
  }

  await bundlePhotoSurface('.', ['@capacitor/camera', 'swiper', 'tui-image-editor']);
  await bundlePhotoSurface('./editor', ['@capacitor/camera', 'swiper']);
  await bundlePhotoSurface('./viewer', ['@capacitor/camera', 'tui-image-editor']);
  await bundlePhotoSurface('./file', ['@capacitor/camera', 'swiper']);
  await bundlePhotoSurface('./editor/tui', ['@capacitor/camera', 'swiper'], ['tui-image-editor']);
  await bundlePhotoSurface('./file/capacitor', ['swiper', 'tui-image-editor'], ['@capacitor/camera']);

  writeFileSync(
    join(temporaryDirectory, 'consumer.ts'),
    `import { type KitAuthInputMode } from '@rdlabo/ionic-angular-kit';
import { providePhotoEditor, type PhotoEditorProps, type PhotoEditorResult, type PhotoViewerProps, type PhotoViewerResult } from '@rdlabo/ionic-angular-photo-editor';
import { PhotoEditorPage } from '@rdlabo/ionic-angular-photo-editor/editor';
import { createTuiImageEditor } from '@rdlabo/ionic-angular-photo-editor/editor/tui';
import { PhotoFileService } from '@rdlabo/ionic-angular-photo-editor/file';
import { loadCapacitorPhotoCamera } from '@rdlabo/ionic-angular-photo-editor/file/capacitor';
import { PhotoViewerPage } from '@rdlabo/ionic-angular-photo-editor/viewer';
import { ScrollHeaderDirective } from '@rdlabo/ionic-angular-scroll-header';
import { CdkDynamicSizeVirtualScroll, calculateItemCountForPixelDistance } from '@rdlabo/ngx-cdk-scroll-strategies';

const mode: KitAuthInputMode = 'email';
const editorProps: PhotoEditorProps = { value: 'data:image/png;base64,', toolbarColorScheme: 'dark' };
const viewerProps: PhotoViewerProps = { imageUrls: [], toolbarColorScheme: 'light', imageAlt: (_, index) => String(index) };
const editorResult: PhotoEditorResult = { action: 'save', value: editorProps.value };
const viewerResult: PhotoViewerResult = { action: 'delete', index: 0, value: '' };
const symbols = [providePhotoEditor, PhotoEditorPage, createTuiImageEditor, PhotoFileService, loadCapacitorPhotoCamera, PhotoViewerPage, ScrollHeaderDirective, CdkDynamicSizeVirtualScroll];
void [mode, viewerProps, editorResult, viewerResult, symbols, calculateItemCountForPixelDistance([{ itemSize: 10 }], 5)];
`,
  );
  writeFileSync(
    join(temporaryDirectory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: 'ES2022',
        module: 'preserve',
        moduleResolution: 'bundler',
        lib: ['ES2022', 'DOM'],
      },
      files: ['./consumer.ts'],
    }),
  );
  execFileSync(join(workspace, 'node_modules', '.bin', 'tsc'), ['-p', join(temporaryDirectory, 'tsconfig.json')], { stdio: 'inherit' });
  console.log('Packed package consumer type-check and optional-peer bundle matrix passed.');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
