const LS_ADDRESS_LABELS = "nebgov_address_labels";

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

export function getAllLabels(): AddressLabels {
  return {
    envLabels: parseEnvLabels(),
    customLabels: getCustomLabels(),
  };
}

export function getAddressLabel(address: string): string | null {
  const { envLabels, customLabels } = getAllLabels();
  return customLabels[address] ?? envLabels[address] ?? null;
}

export function getCustomLabels(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const stored = localStorage.getItem(LS_ADDRESS_LABELS);
    if (!stored) return {};
    const data = JSON.parse(stored) as AddressLabel[];
    return getLabelMap(data);
  } catch {
    return {};
  }
}

export function setCustomLabel(address: string, label: string): void {
  if (typeof window === "undefined") return;
  try {
    const stored = localStorage.getItem(LS_ADDRESS_LABELS);
    const labels: AddressLabel[] = stored ? JSON.parse(stored) : [];
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
    localStorage.setItem(LS_ADDRESS_LABELS, JSON.stringify(labels));
  } catch {
    // ignore
  }
}

export function removeCustomLabel(address: string): void {
  if (typeof window === "undefined") return;
  try {
    const stored = localStorage.getItem(LS_ADDRESS_LABELS);
    if (!stored) return;
    const labels: AddressLabel[] = JSON.parse(stored);
    const filtered = labels.filter((l) => l.address !== address);
    localStorage.setItem(LS_ADDRESS_LABELS, JSON.stringify(filtered));
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
    localStorage.setItem(LS_ADDRESS_LABELS, JSON.stringify(labels));
    return true;
  } catch {
    return false;
  }
}