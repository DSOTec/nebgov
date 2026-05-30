const LS_ADDRESS_LABELS = "nebgov_address_labels";
const ENV_ADDRESS_LABELS = parseEnvLabels();

let cachedCustomLabelsRaw: string | null = null;
let cachedCustomLabelsMap: Record<string, string> | null = null;
let storageListenerAttached = false;

export interface AddressLabel {
  address: string;
  label: string;
  createdAt: number;
}

export interface AddressLabels {
  envLabels: Record<string, string>;
  customLabels: Record<string, string>;
}

function parseEnvLabels(): Record<string, string> {
  const envVar = process.env.NEXT_PUBLIC_ADDRESS_LABELS;
  if (!envVar) return {};

  const labels: Record<string, string> = {};
  const pairs = envVar.split(",");
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx > 0) {
      const addr = pair.substring(0, idx).trim();
      const label = pair.substring(idx + 1).trim();
      if (addr && label) {
        labels[addr] = label;
      }
    }
  }
  return labels;
}

function getLabelMap(labels: AddressLabel[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const item of labels) {
    map[item.address] = item.label;
  }
  return map;
}

function ensureStorageListener(): void {
  if (typeof window === "undefined" || storageListenerAttached) return;

  window.addEventListener("storage", (event) => {
    if (event.key === LS_ADDRESS_LABELS || event.key === null) {
      cachedCustomLabelsRaw = null;
      cachedCustomLabelsMap = null;
    }
  });

  storageListenerAttached = true;
}

function readCustomLabelsMap(): Record<string, string> {
  if (typeof window === "undefined") return {};

  ensureStorageListener();

  try {
    const stored = localStorage.getItem(LS_ADDRESS_LABELS);
    if (stored === cachedCustomLabelsRaw && cachedCustomLabelsMap) {
      return cachedCustomLabelsMap;
    }

    const data = stored ? (JSON.parse(stored) as AddressLabel[]) : [];
    cachedCustomLabelsRaw = stored;
    cachedCustomLabelsMap = getLabelMap(data);
    return cachedCustomLabelsMap;
  } catch {
    cachedCustomLabelsRaw = null;
    cachedCustomLabelsMap = {};
    return {};
  }
}

function writeCustomLabels(labels: AddressLabel[]): void {
  cachedCustomLabelsRaw = JSON.stringify(labels);
  cachedCustomLabelsMap = getLabelMap(labels);
  localStorage.setItem(LS_ADDRESS_LABELS, cachedCustomLabelsRaw);
}

export function getAllLabels(): AddressLabels {
  return {
    envLabels: ENV_ADDRESS_LABELS,
    customLabels: getCustomLabels(),
  };
}

export function getAddressLabel(address: string): string | null {
  const { envLabels, customLabels } = getAllLabels();
  return customLabels[address] ?? envLabels[address] ?? null;
}

export function getCustomLabels(): Record<string, string> {
  if (typeof window === "undefined") return {};
  return readCustomLabelsMap();
}

export function setCustomLabel(address: string, label: string): void {
  if (typeof window === "undefined") return;
  try {
    const labels: AddressLabel[] = (() => {
      const stored = localStorage.getItem(LS_ADDRESS_LABELS);
      if (!stored) return [];
      return JSON.parse(stored) as AddressLabel[];
    })();
    const existing = labels.findIndex((l) => l.address === address);
    const newLabel: AddressLabel = {
      address,
      label,
      createdAt: existing >= 0 ? labels[existing].createdAt : Date.now(),
    };
    if (existing >= 0) {
      labels[existing] = newLabel;
    } else {
      labels.push(newLabel);
    }
    writeCustomLabels(labels);
  } catch {
    // ignore
  }
}

export function removeCustomLabel(address: string): void {
  if (typeof window === "undefined") return;
  try {
    const labels: AddressLabel[] = (() => {
      const stored = localStorage.getItem(LS_ADDRESS_LABELS);
      if (!stored) return [];
      return JSON.parse(stored) as AddressLabel[];
    })();
    const filtered = labels.filter((l) => l.address !== address);
    writeCustomLabels(filtered);
  } catch {
    // ignore
  }
}

export function exportCustomLabels(): string {
  const labels = getCustomLabels();
  return JSON.stringify(labels, null, 2);
}

export function importCustomLabels(jsonString: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const imported = JSON.parse(jsonString) as Record<string, unknown>;
    const existing = getCustomLabels();
    const merged: Record<string, string> = { ...existing };

    for (const [address, label] of Object.entries(imported)) {
      if (typeof label === "string") {
        merged[address] = label;
      }
    }

    const labels: AddressLabel[] = Object.entries(merged).map(
      ([address, label]) => ({
        address,
        label,
        createdAt: Date.now(),
      }),
    );
    writeCustomLabels(labels);
    return true;
  } catch {
    return false;
  }
}
