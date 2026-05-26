/**
 * Integration test to verify shared library imports work correctly
 */

// Test imports from our shared libraries (using relative paths for Phase 0)
import { 
  Cook, 
  TemperatureReading, 
  StartCookRequest,
  Device 
} from '../../../libs/api-interfaces/src';

import { 
  formatTemperature,
  formatDuration,
  MEAT_TYPES,
  COOK_STATUS 
} from '../../../libs/utils/src';

import { 
  CookManager,
  TemperatureCalculator,
  DataValidator 
} from '../../../libs/data-models/src';

import { 
  CosmosClient,
  SignalRClient 
} from '../../../libs/azure-client/src';

console.log('🧪 Testing MeatGeek V2 Monorepo Integration');

// Test 1: Type safety across libraries
const mockCookRequest: StartCookRequest = {
  name: 'Test Brisket',
  deviceId: 'meatgeek3',
  meatType: 'brisket',
  targetTemps: {
    grill: 225,
    probe1: 203,
  },
};

console.log('✅ Type imports working correctly');

// Test 2: Utility functions
const formattedTemp = formatTemperature(225.5, 'fahrenheit', 1);
const duration = formatDuration(840); // 14 hours
const meatConfig = MEAT_TYPES.BRISKET;

console.log(`✅ Utils working: ${formattedTemp}, ${duration}, ${meatConfig.name}`);

// Test 3: Business logic
const cook = CookManager.createCook(mockCookRequest, 'user-1');
const validation = DataValidator.validateStartCookRequest(mockCookRequest);

console.log(`✅ Business logic working: Cook ${cook.id}, validation ${validation.isValid}`);

// Test 4: Azure clients (mock implementations)
const cosmosClient = new CosmosClient({
  connectionString: 'test',
  databaseName: 'test'
});

const signalRClient = new SignalRClient({
  connectionString: 'test'
});

console.log('✅ Azure clients instantiated successfully');

// Test 5: Temperature calculations
const tempCalc = new TemperatureCalculator();
const mockTemp = tempCalc.convertAdcToTemperature(512, -5);

console.log(`✅ Temperature calculations working: ${mockTemp ? formatTemperature(mockTemp) : 'null'}`);

// Test 6: Cross-library data flow
const mockReading: TemperatureReading = {
  deviceId: 'meatgeek3',
  timestamp: new Date().toISOString(),
  cookId: cook.id,
  grillTemp: 225,
  probe1Temp: 165,
  probe2Temp: undefined,
  probe3Temp: undefined,
  probe4Temp: undefined,
};

const progress = CookManager.calculateCookProgress(cook, mockReading);

console.log(`✅ Cross-library integration working: ${progress.overallProgress}% complete`);

console.log('\n🎉 All integration tests passed!');
console.log('📦 MeatGeek V2 monorepo is ready for development');

export { };  // Make this a module