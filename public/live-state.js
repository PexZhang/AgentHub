export async function fetchAuthenticatedSnapshot(token) {
  try {
    const response = await fetch("/api/state", {
      headers: {
        "x-agenthub-token": token || "",
      },
      cache: "no-store",
      credentials: "same-origin",
    });

    if (response.status === 401) {
      let message = "读取状态需要有效的 APP_TOKEN";
      try {
        const payload = await response.json();
        if (payload?.message) {
          message = payload.message;
        }
      } catch {
        // Ignore malformed auth payloads and keep the default message.
      }

      return {
        ok: false,
        authRequired: true,
        message,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        authRequired: false,
        message: `状态读取失败：${response.status}`,
      };
    }

    return {
      ok: true,
      authRequired: false,
      data: await response.json(),
    };
  } catch (error) {
    return {
      ok: false,
      authRequired: false,
      message: error?.message || "网络异常，暂时无法同步状态。",
    };
  }
}

export function installSnapshotRecovery({
  connect,
  refreshSnapshot,
  isAuthBlocked,
  hasSnapshot,
  fallbackDelayMs = 1200,
}) {
  let fallbackTimer = null;

  function clearSnapshotFallback() {
    if (fallbackTimer) {
      window.clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  }

  function scheduleSnapshotFallback(reason = "socket-open") {
    clearSnapshotFallback();
    fallbackTimer = window.setTimeout(() => {
      if (isAuthBlocked?.()) {
        return;
      }
      if (hasSnapshot?.()) {
        return;
      }
      refreshSnapshot?.(`fallback:${reason}`);
    }, fallbackDelayMs);
  }

  function resyncVisibleState(reason) {
    if (isAuthBlocked?.()) {
      return;
    }
    connect?.();
    refreshSnapshot?.(reason);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      resyncVisibleState("visible");
    }
  });

  window.addEventListener("pageshow", () => {
    resyncVisibleState("pageshow");
  });

  window.addEventListener("online", () => {
    resyncVisibleState("online");
  });

  return {
    clearSnapshotFallback,
    scheduleSnapshotFallback,
  };
}
