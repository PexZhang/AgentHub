export function normalizeText(value) {
  return String(value || "").trim();
}

export function normalizeDeviceId(value, fallback = "default-device") {
  return normalizeText(value) || fallback;
}

export function normalizeDeviceName(value, fallback = "当前设备") {
  return normalizeText(value) || fallback;
}

export function buildConversationTitle(text, fallback = "New chat") {
  const normalized = normalizeText(text).replace(/\s+/g, " ");
  if (!normalized) {
    return fallback;
  }

  if (normalized.length <= 24) {
    return normalized;
  }

  return `${normalized.slice(0, 24)}…`;
}
