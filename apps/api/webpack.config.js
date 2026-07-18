const { composePlugins, withNx } = require('@nx/webpack');

// Nx reads main/tsConfig/outputPath/assets/target from the build target options
// in project.json; this composes the standard Node build pipeline on top of them.
module.exports = composePlugins(withNx(), (config) => {
  return config;
});
