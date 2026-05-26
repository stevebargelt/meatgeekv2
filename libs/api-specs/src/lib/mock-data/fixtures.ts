import type { Cook } from '@meatgeekv2/api-interfaces';
import type { Device, DeviceConfiguration } from '@meatgeekv2/api-interfaces';
import type { User } from '@meatgeekv2/api-interfaces';

export const MOCK_USER_ID = 'user-001';

export const MOCK_USERS: User[] = [
  {
    id: MOCK_USER_ID,
    email: 'pitmaster@example.com',
    name: 'Pit Master',
    devices: ['meatgeek3', 'meatgeek4', 'meatgeek5'],
    createdAt: '2025-01-01T00:00:00.000Z',
    lastLogin: '2026-05-26T08:00:00.000Z',
    preferences: {
      temperatureUnit: 'fahrenheit',
      timeZone: 'America/Chicago',
      notifications: {
        tempAlerts: true,
        cookComplete: true,
        deviceOffline: true,
        weeklyReports: false,
        productUpdates: false,
        pushNotifications: {
          enabled: true,
          sound: true,
          vibration: true,
          quietHours: { enabled: false, startTime: '22:00', endTime: '07:00' },
        },
        email: { enabled: true, frequency: 'daily' },
        sms: { enabled: false },
      },
      defaultTargetTemps: {
        brisket: { grill: 225, meat: 203 },
        pork_shoulder: { grill: 225, meat: 195 },
      },
      privacy: { shareData: false, publicProfile: false, allowAnalytics: true },
      display: { theme: 'dark', compactMode: false, showAdvancedMetrics: true },
    },
  },
];

const baseConfig: DeviceConfiguration = {
  grillProbeCorrection: -6.0,
  probe1Correction: -8.0,
  probe2Correction: 2.0,
  probe3Correction: -1.0,
  probe4Correction: -5.0,
  temperatureUnit: 'fahrenheit',
  pollingInterval: 5,
  alertSettings: {
    highTempThreshold: 350,
    lowTempThreshold: 175,
    enableSounds: true,
    enablePushNotifications: true,
  },
};

export const MOCK_DEVICES: Device[] = [
  {
    id: 'meatgeek3',
    userId: MOCK_USER_ID,
    name: 'Backyard Smoker',
    model: 'MeatGeek V1',
    location: 'Austin, TX',
    lastSeen: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    isActive: true,
    connectionStatus: 'online',
    configuration: baseConfig,
    firmware: { version: '1.4.2', updateAvailable: false },
  },
  {
    id: 'meatgeek4',
    userId: MOCK_USER_ID,
    name: 'Patio Pellet',
    model: 'MeatGeek V2',
    location: 'Austin, TX',
    lastSeen: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    isActive: true,
    connectionStatus: 'online',
    configuration: { ...baseConfig, grillProbeCorrection: 0 },
    firmware: { version: '2.0.1', updateAvailable: true },
  },
  {
    id: 'meatgeek5',
    userId: MOCK_USER_ID,
    name: 'Spare Offset',
    model: 'MeatGeek V1',
    location: 'Storage',
    lastSeen: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    isActive: false,
    connectionStatus: 'offline',
    configuration: baseConfig,
    firmware: { version: '1.3.0', updateAvailable: true },
  },
];

const COOK_PLANNING_ID = 'cook-planning-001';
const COOK_ACTIVE_ID = 'cook-active-001';
const COOK_COMPLETED_ID = 'cook-completed-001';

export const MOCK_COOKS: Cook[] = [
  {
    id: COOK_PLANNING_ID,
    userId: MOCK_USER_ID,
    deviceId: 'meatgeek3',
    name: 'Weekend Brisket Plan',
    status: 'planning',
    startTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    meatType: 'brisket',
    weight: 12,
    targetTemps: { grill: 225, probe1: 203, probe2: 203 },
    notes: 'Packer cut, trim to 1/4". Inject overnight.',
  },
  {
    id: COOK_ACTIVE_ID,
    userId: MOCK_USER_ID,
    deviceId: 'meatgeek3',
    name: 'Sunday Pork Shoulder',
    status: 'active',
    startTime: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    meatType: 'pork_shoulder',
    weight: 8,
    targetTemps: { grill: 225, probe1: 195 },
    notes: 'Bone-in shoulder, mustard binder + pork rub.',
  },
  {
    id: COOK_COMPLETED_ID,
    userId: MOCK_USER_ID,
    deviceId: 'meatgeek3',
    name: 'Holiday Ribs',
    status: 'completed',
    startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    endTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000).toISOString(),
    meatType: 'ribs',
    weight: 4,
    targetTemps: { grill: 225, probe1: 190 },
    actualDuration: 5,
    maxTemps: { grill: 248, probe1: 192 },
    notes: '3-2-1 method. Slight overshoot on grill at hour 2.',
    rating: 5,
    isPublic: false,
  },
];

export const MOCK_COOK_IDS = {
  planning: COOK_PLANNING_ID,
  active: COOK_ACTIVE_ID,
  completed: COOK_COMPLETED_ID,
} as const;

export function findDeviceById(id: string): Device | undefined {
  return MOCK_DEVICES.find((d) => d.id === id);
}

export function findCookById(id: string): Cook | undefined {
  return MOCK_COOKS.find((c) => c.id === id);
}
