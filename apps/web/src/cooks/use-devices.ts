import { useEffect, useState } from 'react';
import { useApi } from '../api/api-context';
import type { Device } from '../api/client';

/**
 * The caller's devices, for showing a device's name next to its id. Resolves
 * to an empty list if GET /devices fails: callers fall back to the id.
 */
export function useDevices(): Device[] | undefined {
  const api = useApi();
  const [devices, setDevices] = useState<Device[] | undefined>(undefined);
  useEffect(() => {
    let current = true;
    api
      .GET('/devices')
      .then(({ data }) => {
        if (current) setDevices(data?.devices ?? []);
      })
      .catch(() => {
        if (current) setDevices([]);
      });
    return () => {
      current = false;
    };
  }, [api]);
  return devices;
}

export function deviceLabel(deviceId: string, devices: Device[] | undefined): string {
  return devices?.find(device => device.id === deviceId)?.name ?? deviceId;
}
