import { updatePackage } from 'write-pkg';
import path from 'path';
import pkg from './package.json' assert { type: 'json' };
import { exec } from 'child_process';

const workspaces = ['photo-editor', 'scroll-header'];

workspaces.forEach(async (workspace) => {
  const buildPackagePath = path.resolve('./projects/' + workspace);
  const releasePackagePath = path.resolve('./dist/' + workspace);
  await updatePackage(buildPackagePath + '/package.json', { version: pkg.version });
  exec(
    `ng build ${workspace} --configuration=production && cd ${releasePackagePath} && npm publish --access=public`,
    (err, stdout, stderr) => {
      if (err) {
        console.error(err);
        return;
      }
      console.log(stdout);
    },
  );
});
