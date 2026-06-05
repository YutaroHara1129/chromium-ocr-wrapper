export type ProgressState = { ocrTriggered: boolean };

export interface ViewerLike {
  docLength_?: number;
  documentDimensions?: { pageDimensions?: Array<unknown> };
  documentDimensions_?: { pageDimensions?: Array<unknown> };
  viewport_?: { goToPage?: (...args: unknown[]) => unknown; pageCount_?: number; pageDimensions_?: Array<unknown> };
  currentController?: ControllerLike;
}

export interface ControllerLike {
  handlePluginMessage_: (msg: unknown) => unknown;
  save: (...args: unknown[]) => unknown;
}

export function getPageCount(viewer: ViewerLike): number {
  const docLength = viewer.docLength_;
  if (docLength) return docLength;

  const dimsNoUnder = viewer.documentDimensions;
  const dimsNoUnderPages = dimsNoUnder?.pageDimensions?.length;
  if (dimsNoUnderPages) return dimsNoUnderPages;

  const dims = viewer.documentDimensions_;
  const dimsPages = dims?.pageDimensions?.length;
  if (dimsPages) return dimsPages;

  const vp = viewer.viewport_;
  const vpDims = vp?.pageDimensions_?.length;
  if (vpDims) return vpDims;

  return 0;
}

export function setupProgressInterceptor(
  controller: ControllerLike,
  progress: ProgressState,
): void {
  const original = controller.handlePluginMessage_.bind(controller);
  controller.handlePluginMessage_ = function (msg: unknown) {
    const msgData = (msg as { data?: Record<string, unknown> } | undefined)?.data;
    if (msgData?.["type"] === "setHasSearchifyText") {
      progress.ocrTriggered = true;
    }
    return original(msg);
  };
}

export async function scrollAllPages(
  viewer: ViewerLike,
  pageCount: number,
): Promise<void> {
  const vp = viewer.viewport_;
  if (!vp || typeof vp.goToPage !== "function") return;
  for (let i = 0; i < pageCount; i++) {
    vp.goToPage(i);
    await new Promise((r) => setTimeout(r, 300));
  }
}

