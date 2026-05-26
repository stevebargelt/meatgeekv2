/**
 * Application constants for MeatGeek V2
 */

/**
 * Temperature constants
 */
export const TEMPERATURE = {
  // Standard cooking temperatures (Fahrenheit)
  POULTRY: {
    SAFE_TEMP: 165,
    RECOMMENDED: 165,
  },
  PORK: {
    SAFE_TEMP: 145,
    RECOMMENDED: 195, // For pulled pork
  },
  BEEF: {
    RARE: 120,
    MEDIUM_RARE: 130,
    MEDIUM: 140,
    MEDIUM_WELL: 150,
    WELL_DONE: 160,
    BRISKET: 203, // For slicing
  },
  FISH: {
    SAFE_TEMP: 145,
    RECOMMENDED: 145,
  },
  
  // Grill temperature ranges
  GRILL: {
    LOW_AND_SLOW: { min: 200, max: 250 },
    MEDIUM: { min: 250, max: 325 },
    HOT: { min: 325, max: 400 },
    SEARING: { min: 400, max: 500 },
  },
} as const;

/**
 * Cook status constants
 */
export const COOK_STATUS = {
  PLANNING: 'planning',
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const;

/**
 * Device connection status
 */
export const DEVICE_STATUS = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  UNKNOWN: 'unknown',
} as const;

/**
 * Temperature alert types
 */
export const ALERT_TYPES = {
  HIGH: 'high',
  LOW: 'low',
  TARGET_REACHED: 'target_reached',
} as const;

/**
 * Probe identifiers
 */
export const PROBES = {
  GRILL: 'grill',
  PROBE1: 'probe1',
  PROBE2: 'probe2',
  PROBE3: 'probe3',
  PROBE4: 'probe4',
} as const;

/**
 * Meat type configurations
 */
export const MEAT_TYPES = {
  BRISKET: {
    name: 'Brisket',
    defaultGrillTemp: 225,
    defaultMeatTemp: 203,
    estimatedTimePerPound: 90, // minutes
    icon: '🥩',
  },
  PORK_SHOULDER: {
    name: 'Pork Shoulder',
    defaultGrillTemp: 225,
    defaultMeatTemp: 195,
    estimatedTimePerPound: 90,
    icon: '🐷',
  },
  RIBS: {
    name: 'Ribs',
    defaultGrillTemp: 225,
    defaultMeatTemp: 190,
    estimatedTimePerPound: 60,
    icon: '🍖',
  },
  CHICKEN: {
    name: 'Chicken',
    defaultGrillTemp: 325,
    defaultMeatTemp: 165,
    estimatedTimePerPound: 20,
    icon: '🐔',
  },
  TURKEY: {
    name: 'Turkey',
    defaultGrillTemp: 325,
    defaultMeatTemp: 165,
    estimatedTimePerPound: 15,
    icon: '🦃',
  },
  SALMON: {
    name: 'Salmon',
    defaultGrillTemp: 400,
    defaultMeatTemp: 145,
    estimatedTimePerPound: 10,
    icon: '🐟',
  },
} as const;

/**
 * API endpoints
 */
export const API_ENDPOINTS = {
  // Cook management
  COOKS: '/api/cooks',
  COOK_BY_ID: '/api/cooks/{id}',
  START_COOK: '/api/cooks',
  STOP_COOK: '/api/cooks/{id}/stop',
  
  // Temperature data
  TEMPERATURES: '/api/temperatures',
  CURRENT_TEMPS: '/api/temperatures/current/{deviceId}',
  TEMP_HISTORY: '/api/temperatures/history',
  
  // Device management
  DEVICES: '/api/devices',
  DEVICE_BY_ID: '/api/devices/{id}',
  DEVICE_STATUS: '/api/devices/{id}/status',
  
  // User management
  AUTH: '/api/auth',
  LOGIN: '/api/auth/login',
  REGISTER: '/api/auth/register',
  REFRESH: '/api/auth/refresh',
  
  // Real-time
  SIGNALR_HUB: '/api/signalr',
  TEMPERATURE_HUB: '/temperatureHub',
} as const;

/**
 * Local storage keys
 */
export const STORAGE_KEYS = {
  AUTH_TOKEN: 'meatgeek_auth_token',
  REFRESH_TOKEN: 'meatgeek_refresh_token',
  USER_PREFERENCES: 'meatgeek_user_preferences',
  DEVICE_CONFIG: 'meatgeek_device_config',
  ACTIVE_COOK: 'meatgeek_active_cook',
  TEMPERATURE_UNIT: 'meatgeek_temperature_unit',
} as const;

/**
 * Time constants (in milliseconds)
 */
export const TIME = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
  
  // Polling intervals
  TEMPERATURE_POLL_INTERVAL: 5 * 1000, // 5 seconds
  DEVICE_STATUS_POLL_INTERVAL: 30 * 1000, // 30 seconds
  CONNECTION_RETRY_DELAY: 5 * 1000, // 5 seconds
} as const;

/**
 * Validation constants
 */
export const VALIDATION = {
  TEMPERATURE: {
    MIN: -50,
    MAX: 1000,
  },
  COOK_NAME: {
    MIN_LENGTH: 3,
    MAX_LENGTH: 50,
  },
  DEVICE_NAME: {
    MIN_LENGTH: 3,
    MAX_LENGTH: 30,
  },
  EMAIL: {
    PATTERN: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  },
  PHONE: {
    PATTERN: /^\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})$/,
  },
} as const;

/**
 * Chart and UI constants
 */
export const CHART = {
  COLORS: {
    GRILL_TEMP: '#ef4444',
    PROBE1_TEMP: '#3b82f6',
    PROBE2_TEMP: '#10b981',
    PROBE3_TEMP: '#f59e0b',
    PROBE4_TEMP: '#8b5cf6',
    TARGET_TEMP: '#6b7280',
  },
  MAX_POINTS: 500, // Maximum points to show on live charts
  UPDATE_INTERVAL: 5000, // Chart update interval in ms
} as const;

/**
 * Error codes
 */
export const ERROR_CODES = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  COOK_NOT_FOUND: 'COOK_NOT_FOUND',
  INVALID_TEMPERATURE: 'INVALID_TEMPERATURE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const;

/**
 * Feature flags
 */
export const FEATURES = {
  ENABLE_PUSH_NOTIFICATIONS: true,
  ENABLE_SOCIAL_SHARING: true,
  ENABLE_ADVANCED_ANALYTICS: true,
  ENABLE_VOICE_COMMANDS: false,
  ENABLE_WEATHER_INTEGRATION: true,
} as const;