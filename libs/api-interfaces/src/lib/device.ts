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
  firmware?: {
    version: string;
    updateAvailable: boolean;
  };
  /**
   * HAR-130: when the owner claimed the device with its claim code (ISO-8601
   * UTC). Absent on a device registered through `POST /devices` before HAR-145
   * removed it.
   */
  claimedAt?: string;
  /**
   * HAR-143 (goal HAR-130): whether the device is connected to IoT Hub and
   * when the hub last heard from it, read live from the device's twin on every
   * `GET /devices` and `GET /devices/{id}`. Never stored. The other routes that
   * return a Device leave it out.
   */
  connection?: DeviceConnection;
}

/** HAR-143: what IoT Hub says about a device's connection. */
export type DeviceConnectionState = 'connected' | 'disconnected' | 'unknown';

/**
 * HAR-143: a device's connection, from its IoT Hub twin: `state` from the
 * top-level `connectionState`; `lastActivityAt` the later of the top-level
 * `lastActivityTime` and the device's last reported-properties write
 * (`properties.reported.$metadata.$lastUpdated`). `unknown` with
 * `lastActivityAt: null` when the twin could not be read (no twin, a failure,
 * a timeout).
 */
export interface DeviceConnection {
  state: DeviceConnectionState;
  /** ISO-8601 UTC; `null` when the hub has never heard from the device. */
  lastActivityAt: string | null;
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
 * HAR-130: the body of `POST /devices/claim`, since HAR-145 the only way a
 * device gets an owner (`POST /devices` is removed). `claimCode` is the code the
 * device shows (`XXXX-XXXX-XXXX`); case, hyphens and spaces do not matter.
 * `model` defaults to `"MeatGeek"`.
 */
export interface ClaimDeviceRequest {
  deviceId: string;
  claimCode: string;
  name: string;
  model?: string;
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