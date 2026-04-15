function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function copyText(text) {
  const normalized = String(text || "");
  if (!normalized) {
    throw new Error("EMPTY_TEXT");
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(normalized);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = normalized;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

export function renderCopyMessageButton(messageId) {
  const resolvedId = String(messageId || "").trim();
  if (!resolvedId) {
    return "";
  }

  return `
    <button
      type="button"
      class="message-copy-button"
      data-copy-message-id="${escapeHtml(resolvedId)}"
      aria-label="复制这条消息"
    >
      复制
    </button>
  `;
}

export function bindCopyMessageButtons(rootNode, resolveText) {
  if (!rootNode || typeof resolveText !== "function") {
    return;
  }

  rootNode.querySelectorAll("[data-copy-message-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const messageId = button.dataset.copyMessageId || "";
      const text = resolveText(messageId);
      if (!text) {
        button.textContent = "无内容";
        window.setTimeout(() => {
          button.textContent = "复制";
        }, 1200);
        return;
      }

      const originalText = button.textContent;
      button.disabled = true;
      try {
        await copyText(text);
        button.textContent = "已复制";
      } catch {
        button.textContent = "复制失败";
      }

      window.setTimeout(() => {
        button.disabled = false;
        button.textContent = originalText;
      }, 1200);
    });
  });
}
