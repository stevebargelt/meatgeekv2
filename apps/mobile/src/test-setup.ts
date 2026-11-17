import 'react-native-gesture-handler/jestSetup';

// Mock React Native modules
jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return Reanimated;
});

// Silence the warning: Animated: `useNativeDriver` is not supported
jest.mock('react-native/Libraries/Animated/NativeAnimatedHelper');

// Mock AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Mock NetInfo
jest.mock('@react-native-community/netinfo', () => {
  return {
    fetch: jest.fn(() => Promise.resolve({
      isConnected: true,
      isInternetReachable: true,
      type: 'wifi',
      details: {
        isConnectionExpensive: false,
      },
    })),
    addEventListener: jest.fn(),
  };
});

// Global test setup.
// react-native's types declare __DEV__ as a block-scoped `const`, so it is not a
// property of `globalThis` in the type system and cannot be assigned directly.
// Define it as a property instead, the same way react-native/jest/setup.js does.
Object.defineProperty(globalThis, '__DEV__', {
  configurable: true,
  enumerable: true,
  value: true,
  writable: true,
});
