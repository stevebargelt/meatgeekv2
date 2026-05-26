/**
 * BBQ device information and configuration
 */
export interface Device {
  id: string;
  userId: string;
  name: string;
  model: string;
  location?: string;
  lastSeen?: string;
  isActive: boolean;
  configuration?: DeviceConfiguration;
  connectionStatus: 'online' | 'offline' | 'unknown';
  firmware?: {
    version: string;
    updateAvailable: boolean;
  };
}

/**
 * Device configuration settings
 */
export interface DeviceConfiguration {
  grillProbeCorrection?: number;
  probe1Correction?: number;
  probe2Correction?: number;
  probe3Correction?: number;
  probe4Correction?: number;
  temperatureUnit: 'fahrenheit' | 'celsius';
  pollingInterval: number; // seconds
  alertSettings: {
    highTempThreshold: number;
    lowTempThreshold: number;
    enableSounds: boolean;
    enablePushNotifications: boolean;
  };
}

/**
 * Device registration request
 */
export interface RegisterDeviceRequest {
  deviceId: string;
  name: string;
  model: string;
  location?: string;
  configuration?: Partial<DeviceConfiguration>;
}

/**
 * Device update request
 */
export interface UpdateDeviceRequest {
  name?: string;
  location?: string;
  configuration?: Partial<DeviceConfiguration>;
}

/**
 * Device status from hardware controller
 */
export interface DeviceStatus {
  deviceId: string;
  timestamp: string;
  augerOn: boolean;
  blowerOn: boolean;
  igniterOn: boolean;
  fireHealthy: boolean;
  mode: string;
  setPoint: number;
  currentTemps: {
    grill: number;
    probe1?: number;
    probe2?: number;
    probe3?: number;
    probe4?: number;
  };
  systemHealth: {
    cpuUsage: number;
    memoryUsage: number;
    diskUsage: number;
    networkStatus: 'connected' | 'disconnected';
  };
}

/**
 * Device command for remote control
 */
export interface DeviceCommand {
  commandId: string;
  deviceId: string;
  command: 'start_cook' | 'stop_cook' | 'set_temperature' | 'update_config' | 'restart';
  parameters?: Record<string, unknown>;
  timestamp: string;
  expiresAt?: string;
}

/**
 * Device command response
 */
export interface DeviceCommandResponse {
  commandId: string;
  status: 'success' | 'error' | 'timeout';
  message?: string;
  result?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Device telemetry batch for efficient uploads
 */
export interface DeviceTelemetryBatch {
  deviceId: string;
  batchId: string;
  startTime: string;
  endTime: string;
  readings: Array<{
    timestamp: string;
    grillTemp?: number;
    probe1Temp?: number;
    probe2Temp?: number;
    probe3Temp?: number;
    probe4Temp?: number;
  }>;
  metadata: {
    cookId?: string;
    sampleRate: number; // seconds
    compressionType?: 'none' | 'gzip';
  };
}