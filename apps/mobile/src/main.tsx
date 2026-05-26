import React from 'react';
import { AppRegistry, LogBox } from 'react-native';
import App from './app/App';

// Suppress specific warnings in development
if (__DEV__) {
  LogBox.ignoreLogs([
    'Non-serializable values were found in the navigation state',
  ]);
}

const MeatGeekApp = () => <App />;

AppRegistry.registerComponent('MeatGeekMobile', () => MeatGeekApp);

export default MeatGeekApp;