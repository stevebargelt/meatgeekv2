const { withNxMetro } = require('@nx/react-native');
const { getDefaultConfig } = require('metro-config');

module.exports = (async () => {
  const defaultConfig = await getDefaultConfig(__dirname);
  
  return withNxMetro(defaultConfig, {
    // Change this to true to see which packages are being bundled
    verbose: false,
    extensions: [...defaultConfig.resolver.sourceExts, 'jsx', 'ts', 'tsx'],
    // Additional configuration can be added here
  });
})();