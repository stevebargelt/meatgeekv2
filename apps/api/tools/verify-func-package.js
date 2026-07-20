'use strict';

// Deterministic, credential-free check that a built directory is a well-formed
// Azure Functions (Node v4 programming model) deployment package. All internal
// paths are validated RELATIVE TO the given package root — the same directory
// `func azure functionapp publish` is invoked from (dist/apps/api).
const fs = require('fs');
const path = require('path');

function verifyFuncPackage(root) {
  const errors = [];

  const hostPath = path.join(root, 'host.json');
  if (!fs.existsSync(hostPath)) {
    errors.push(`host.json missing at package root (${hostPath})`);
  } else {
    let host;
    try {
      host = JSON.parse(fs.readFileSync(hostPath, 'utf8'));
    } catch (e) {
      errors.push(`host.json is not parseable JSON: ${e.message}`);
    }
    if (host) {
      if (host.version !== '2.0') {
        errors.push(`host.json version must be "2.0" (found ${JSON.stringify(host.version)})`);
      }
      if (!host.extensionBundle || !host.extensionBundle.id || !host.extensionBundle.version) {
        errors.push('host.json extensionBundle.id/version missing (required for the v4 model)');
      }
      // The v4 Node model registers functions from package.json "main"; a lingering
      // custom-handler httpWorker block would override that and break the deploy.
      if (host.httpWorker) {
        errors.push('host.json contains an httpWorker block, invalid for the Node v4 model');
      }
    }
  }

  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    errors.push(`package.json missing at package root (${pkgPath})`);
  } else {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (e) {
      errors.push(`package.json is not parseable JSON: ${e.message}`);
    }
    if (pkg) {
      if (!pkg.main) {
        errors.push('package.json "main" missing (v4 model entry point)');
      } else if (path.isAbsolute(pkg.main) || pkg.main.startsWith('..')) {
        errors.push(
          `package.json "main" must be relative to the artifact root (found ${pkg.main})`
        );
      } else {
        const mainPath = path.join(root, pkg.main);
        if (!fs.existsSync(mainPath)) {
          errors.push(
            `package.json "main" (${pkg.main}) does not resolve to a file under the artifact root`
          );
        }
      }
      if (!pkg.dependencies || !pkg.dependencies['@azure/functions']) {
        errors.push('package.json must declare @azure/functions as a dependency');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { verifyFuncPackage };

if (require.main === module) {
  const root = process.argv[2] || 'dist/apps/api';
  const { ok, errors } = verifyFuncPackage(root);
  if (ok) {
    console.log(`✓ ${root} is a well-formed Azure Functions v4 package`);
    process.exit(0);
  }
  console.error(`✗ ${root} is not a valid Azure Functions package:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
