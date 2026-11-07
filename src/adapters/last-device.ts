const STORAGE_KEY = 'datecs-wp25:last-device:v1';

export interface LastDevice {
  vendorId: number;
  productId: number;
  label: string;
  savedAt: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readLastDevice(): LastDevice | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<LastDevice>;
    if (typeof value.vendorId !== 'number' || typeof value.productId !== 'number') return null;
    return {
      vendorId: value.vendorId,
      productId: value.productId,
      label: typeof value.label === 'string' ? value.label : 'Web Serial device',
      savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function rememberPort(port: WebSerialPort): LastDevice | null {
  try {
    if (typeof port.getInfo !== 'function') return null;
    const info = port.getInfo();
    if (typeof info.usbVendorId !== 'number' || typeof info.usbProductId !== 'number') return null;
    const device: LastDevice = {
      vendorId: info.usbVendorId,
      productId: info.usbProductId,
      label: 'Web Serial device',
      savedAt: Date.now(),
    };
    storage()?.setItem(STORAGE_KEY, JSON.stringify(device));
    return device;
  } catch {
    return null;
  }
}

export function matchesLastDevice(port: WebSerialPort, device: LastDevice | null): boolean {
  if (!device || typeof port.getInfo !== 'function') return false;
  const info = port.getInfo();
  return info.usbVendorId === device.vendorId && info.usbProductId === device.productId;
}
