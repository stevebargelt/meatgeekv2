module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'module-resolver',
      {
        root: ['./src'],
        alias: {
          '@meatgeekv2/ui-components': '../../libs/ui-components/src/index.ts',
          '@meatgeekv2/api-interfaces': '../../libs/api-interfaces/src/index.ts',
          '@meatgeekv2/realtime': '../../libs/realtime/src/index.ts',
          '@meatgeekv2/utils': '../../libs/utils/src/index.ts',
        },
      },
    ],
  ],
};