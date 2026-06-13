import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPageCount,
  setupProgressInterceptor,
  scrollAllPages,
  type ViewerLike,
  type ControllerLike,
  type ProgressState,
} from "./viewer-ocr-ops.js";

function createViewer(overrides?: Partial<ViewerLike>): ViewerLike {
  return {
    docLength_: 3,
    viewport_: {
      goToPage: vi.fn(),
      pageCount_: 3,
    },
    currentController: {
      handlePluginMessage_: vi.fn(),
      save: vi.fn(),
    },
    ...overrides,
  };
}

function createController(overrides?: Partial<ControllerLike>): ControllerLike {
  return {
    handlePluginMessage_: vi.fn(),
    save: vi.fn(),
    ...overrides,
  };
}

describe("getPageCount", () => {
  it("returns docLength_ when present", () => {
    const viewer = createViewer({ docLength_: 244 });
    expect(getPageCount(viewer)).toBe(244);
  });

  it("falls back to documentDimensions.pageDimensions.length (no underscore)", () => {
    const viewer = createViewer({
      docLength_: undefined,
      documentDimensions: {
        pageDimensions: new Array(10),
      },
    });
    expect(getPageCount(viewer)).toBe(10);
  });

  it("falls back to documentDimensions_.pageDimensions.length", () => {
    const viewer = createViewer({
      docLength_: undefined,
      documentDimensions_: {
        pageDimensions: new Array(8),
      },
    });
    expect(getPageCount(viewer)).toBe(8);
  });

  it("falls back to viewport_.pageDimensions_.length as last resort", () => {
    const viewer = createViewer({
      docLength_: undefined,
      viewport_: { goToPage: vi.fn(), pageDimensions_: new Array(5) },
    });
    expect(getPageCount(viewer)).toBe(5);
  });

  it("returns 0 when all sources are absent", () => {
    const viewer = createViewer({
      docLength_: undefined,
      viewport_: undefined,
    });
    expect(getPageCount(viewer)).toBe(0);
  });

  it("prefers docLength_ over documentDimensions", () => {
    const viewer = createViewer({
      docLength_: 3,
      documentDimensions: { pageDimensions: new Array(100) },
    });
    expect(getPageCount(viewer)).toBe(3);
  });

  it("prefers documentDimensions (no under) over documentDimensions_", () => {
    const viewer = createViewer({
      docLength_: undefined,
      documentDimensions: { pageDimensions: new Array(10) },
      documentDimensions_: { pageDimensions: new Array(99) },
    });
    expect(getPageCount(viewer)).toBe(10);
  });

  it("prefers documentDimensions_ over viewport_.pageDimensions_", () => {
    const viewer = createViewer({
      docLength_: undefined,
      documentDimensions_: { pageDimensions: new Array(10) },
      viewport_: { goToPage: vi.fn(), pageDimensions_: new Array(99) },
    });
    expect(getPageCount(viewer)).toBe(10);
  });
});

describe("setupProgressInterceptor", () => {
  let progress: ProgressState;

  beforeEach(() => {
    progress = { ocrTriggered: false };
  });

  it("sets ocrTriggered=true on setHasSearchifyText", () => {
    const controller = createController();
    setupProgressInterceptor(controller, progress);

    controller.handlePluginMessage_({
      data: { type: "setHasSearchifyText" },
    });

    expect(progress.ocrTriggered).toBe(true);
  });

  it("does not alter progress for unrelated message types", () => {
    const controller = createController();
    setupProgressInterceptor(controller, progress);

    controller.handlePluginMessage_({
      data: { type: "unrelatedMessage" },
    });

    expect(progress.ocrTriggered).toBe(false);
  });

  it("does not alter progress for showSearchifyInProgress (dead in headless)", () => {
    const controller = createController();
    setupProgressInterceptor(controller, progress);

    controller.handlePluginMessage_({
      data: { type: "showSearchifyInProgress", show: true },
    });

    expect(progress.ocrTriggered).toBe(false);
  });

  it("calls the original handlePluginMessage_ for every message", () => {
    const original = vi.fn();
    const controller = createController({ handlePluginMessage_: original });
    setupProgressInterceptor(controller, progress);

    const msg = { data: { type: "other" } };
    controller.handlePluginMessage_(msg);

    expect(original).toHaveBeenCalledWith(msg);
  });

  it("calls original handler even for intercepted message types", () => {
    const original = vi.fn();
    const controller = createController({ handlePluginMessage_: original });
    setupProgressInterceptor(controller, progress);

    const msg = { data: { type: "setHasSearchifyText" } };
    controller.handlePluginMessage_(msg);

    expect(original).toHaveBeenCalledWith(msg);
    expect(progress.ocrTriggered).toBe(true);
  });

  it("preserves this context when calling original handler", () => {
    const original = vi.fn(function (this: ControllerLike) {
      expect(this).toBe(controller);
    });
    const controller = createController({ handlePluginMessage_: original });
    setupProgressInterceptor(controller, progress);

    controller.handlePluginMessage_({ data: { type: "x" } });
    expect(original).toHaveBeenCalled();
  });

  it("handles message without data property", () => {
    const controller = createController();
    setupProgressInterceptor(controller, progress);

    expect(() => {
      controller.handlePluginMessage_({});
    }).not.toThrow();

    expect(progress.ocrTriggered).toBe(false);
  });
});

describe("scrollAllPages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls goToPage for each page with 300ms delay", async () => {
    const goToPage = vi.fn();
    const viewer = createViewer({
      viewport_: { goToPage },
    });

    const promise = scrollAllPages(viewer, 3);
    await vi.advanceTimersByTimeAsync(900);
    await promise;

    expect(goToPage).toHaveBeenCalledTimes(3);
    expect(goToPage).toHaveBeenNthCalledWith(1, 0);
    expect(goToPage).toHaveBeenNthCalledWith(2, 1);
    expect(goToPage).toHaveBeenNthCalledWith(3, 2);
  });

  it("does nothing when pageCount is 0", async () => {
    const goToPage = vi.fn();
    const viewer = createViewer({ viewport_: { goToPage } });

    await scrollAllPages(viewer, 0);

    expect(goToPage).not.toHaveBeenCalled();
  });

  it("does nothing when viewport_ is absent", async () => {
    const viewer = createViewer({ viewport_: undefined });

    await scrollAllPages(viewer, 5);
  });

  it("does nothing when viewport_ has no goToPage method", async () => {
    const viewer = createViewer({ viewport_: {} as never });

    await scrollAllPages(viewer, 5);
  });

  it("invokes onPageScrolled callback for each page in order", async () => {
    const goToPage = vi.fn();
    const viewer = createViewer({ viewport_: { goToPage } });
    const events: Array<{ pageIndex: number; pageCount: number }> = [];

    const promise = scrollAllPages(viewer, 3, (pageIndex, pageCount) => {
      events.push({ pageIndex, pageCount });
    });
    await vi.advanceTimersByTimeAsync(900);
    await promise;

    expect(events).toEqual([
      { pageIndex: 0, pageCount: 3 },
      { pageIndex: 1, pageCount: 3 },
      { pageIndex: 2, pageCount: 3 },
    ]);
  });

  it("does not invoke callback when pageCount is 0", async () => {
    const goToPage = vi.fn();
    const viewer = createViewer({ viewport_: { goToPage } });
    const onPageScrolled = vi.fn();

    await scrollAllPages(viewer, 0, onPageScrolled);

    expect(onPageScrolled).not.toHaveBeenCalled();
  });

  it("works without callback (backward compatible)", async () => {
    const goToPage = vi.fn();
    const viewer = createViewer({ viewport_: { goToPage } });

    const promise = scrollAllPages(viewer, 2);
    await vi.advanceTimersByTimeAsync(600);
    await promise;

    expect(goToPage).toHaveBeenCalledTimes(2);
  });
});
