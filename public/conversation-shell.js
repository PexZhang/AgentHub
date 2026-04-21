export function syncConversationShellOffsets({
  stageNode,
  overlayNode,
  composerNode,
} = {}) {
  if (!stageNode) {
    return;
  }

  const topOffset = overlayNode?.offsetHeight || 0;
  const bottomOffset = composerNode?.offsetHeight || 0;
  stageNode.style.setProperty("--overlay-top-offset", `${topOffset}px`);
  stageNode.style.setProperty("--overlay-bottom-offset", `${bottomOffset}px`);
}

export function bindConversationShellResizeTracking({
  stageNode,
  overlayNode,
  composerNode,
  onSync,
} = {}) {
  if (!stageNode) {
    return () => {};
  }

  const sync =
    typeof onSync === "function"
      ? onSync
      : () =>
          syncConversationShellOffsets({
            stageNode,
            overlayNode,
            composerNode,
          });

  let observer = null;

  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      sync();
    });

    if (overlayNode) {
      observer.observe(overlayNode);
    }

    if (composerNode) {
      observer.observe(composerNode);
    }
  }

  window.addEventListener("resize", sync);

  return () => {
    observer?.disconnect();
    window.removeEventListener("resize", sync);
  };
}

export function applyConversationOverlayCollapsedState({
  overlayNode,
  expandedNodes = [],
  collapsedBarNode,
  collapsedSummaryNode,
  collapsed,
  summaryText = "",
} = {}) {
  const isCollapsed = Boolean(collapsed);

  expandedNodes.forEach((node) => {
    if (node) {
      node.hidden = isCollapsed;
    }
  });

  if (collapsedBarNode) {
    collapsedBarNode.hidden = !isCollapsed;
  }

  if (collapsedSummaryNode) {
    collapsedSummaryNode.textContent = summaryText;
  }

  if (overlayNode) {
    overlayNode.classList.toggle("is-collapsed", isCollapsed);
  }
}
