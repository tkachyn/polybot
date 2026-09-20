/**
 * Keeps each racer's Steel live-view iframe in one place while any view shows
 * it. Moving an iframe to another parent reloads it (Steel's "Connecting to
 * browser"), so rather than moving it between the grid pane and the focus
 * view, every iframe lives in one layer over the arena stage and is laid over
 * whichever of its hosts is showing. Opening and closing the focus view only
 * changes the iframe's position and size; the stream never reconnects.
 */
import { createContext } from "react";

/** How long an iframe outlives its last host, so a quick remount (StrictMode, a layout toggle) reuses it. */
export const VIEWER_RELEASE_GRACE_MS = 10_000;

/**
 * Steel drops viewer connections opened in the same instant: an arena's four
 * iframes would race, one would connect and the rest would sit on "Browser
 * disconnected" until Steel's own retry. Each iframe's first load waits this
 * much longer than the one before it.
 */
export const VIEWER_CONNECT_STAGGER_MS = 350;

export type HostSlot = { concealed: boolean; order: number };

/** The host to lay a viewer over: the newest one that is not concealed. */
export function pickActiveHost<T extends HostSlot>(hosts: Iterable<T>): T | null {
  let active: T | null = null;
  for (const host of hosts) {
    if (!host.concealed && (active === null || host.order > active.order)) active = host;
  }
  return active;
}

export type ViewerOptions = {
  url: string;
  title: string;
  /** The host stays mounted but gives up the viewer (the grid under the focus view). */
  concealed: boolean;
  onError: () => void;
};

export type ViewerHandle = {
  update(options: ViewerOptions): void;
  release(): void;
};

type Host = HostSlot & { el: HTMLElement; onError: () => void };

type Viewer = {
  iframe: HTMLIFrameElement;
  url: string;
  hosts: Set<Host>;
  removal: ReturnType<typeof setTimeout> | null;
  /** Pending first load, while this iframe waits its turn to connect. */
  connect: ReturnType<typeof setTimeout> | null;
};

export class ViewerLayer {
  private readonly viewers = new Map<string, Viewer>();
  private readonly resize: ResizeObserver | null;
  private nextOrder = 0;
  private frame = 0;
  private destroyed = false;
  /** When the next iframe may start loading, so first connections queue up. */
  private nextConnectAt = 0;

  /** `root` is an absolutely positioned element over the stage; the iframes are its only children. */
  constructor(private readonly root: HTMLElement) {
    // Resize callbacks run after layout and before paint, so the iframe follows without a frame of lag.
    this.resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.layout());
    this.resize?.observe(root);
    window.addEventListener("resize", this.schedule);
    document.addEventListener("scroll", this.schedule, { capture: true, passive: true });
  }

  attach(key: string, el: HTMLElement, options: ViewerOptions): ViewerHandle {
    const viewer = this.viewerFor(key, options);
    const host: Host = { el, concealed: options.concealed, order: ++this.nextOrder, onError: options.onError };
    viewer.hosts.add(host);
    this.resize?.observe(el);
    this.layout();
    let released = false;
    return {
      update: (next) => {
        if (released) return;
        host.concealed = next.concealed;
        host.onError = next.onError;
        this.apply(viewer, next);
        this.layout();
      },
      release: () => {
        if (released) return;
        released = true;
        viewer.hosts.delete(host);
        this.resize?.unobserve(el);
        if (viewer.hosts.size === 0) this.scheduleRemoval(key, viewer);
        this.layout();
      },
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resize?.disconnect();
    window.removeEventListener("resize", this.schedule);
    document.removeEventListener("scroll", this.schedule, { capture: true });
    for (const viewer of this.viewers.values()) {
      if (viewer.removal) clearTimeout(viewer.removal);
      if (viewer.connect) clearTimeout(viewer.connect);
      viewer.iframe.remove();
    }
    this.viewers.clear();
  }

  private viewerFor(key: string, options: ViewerOptions): Viewer {
    const existing = this.viewers.get(key);
    if (existing) {
      if (existing.removal) clearTimeout(existing.removal);
      existing.removal = null;
      this.apply(existing, options);
      return existing;
    }
    const iframe = document.createElement("iframe");
    iframe.allow = "autoplay; fullscreen";
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.visibility = "hidden";
    const viewer: Viewer = { iframe, url: "", hosts: new Set(), removal: null, connect: null };
    iframe.addEventListener("error", () => {
      for (const host of viewer.hosts) host.onError();
    });
    this.root.appendChild(iframe);
    this.viewers.set(key, viewer);
    this.scheduleConnect(viewer, options);
    return viewer;
  }

  /** Sets the title, and the source only when the URL really changed: a src write reloads the viewer. */
  private apply(viewer: Viewer, { url, title }: ViewerOptions): void {
    const { iframe } = viewer;
    if (iframe.title !== title) iframe.title = title;
    if (viewer.url === url) return;
    viewer.url = url;
    // A queued first load reads the latest URL when its turn comes.
    if (viewer.connect === null) iframe.src = url;
  }

  /** Queues this iframe's first load behind the ones already waiting. */
  private scheduleConnect(viewer: Viewer, options: ViewerOptions): void {
    viewer.url = options.url;
    viewer.iframe.title = options.title;
    const now = Date.now();
    const at = Math.max(now, this.nextConnectAt);
    this.nextConnectAt = at + VIEWER_CONNECT_STAGGER_MS;
    viewer.connect = setTimeout(() => {
      viewer.connect = null;
      if (this.destroyed) return;
      viewer.iframe.src = viewer.url;
    }, at - now);
  }

  private scheduleRemoval(key: string, viewer: Viewer): void {
    if (viewer.removal) clearTimeout(viewer.removal);
    viewer.removal = setTimeout(() => {
      viewer.removal = null;
      if (viewer.hosts.size > 0 || this.viewers.get(key) !== viewer) return;
      if (viewer.connect) clearTimeout(viewer.connect);
      viewer.iframe.remove();
      this.viewers.delete(key);
    }, VIEWER_RELEASE_GRACE_MS);
  }

  private readonly schedule = (): void => {
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.layout();
    });
  };

  /** Lays every viewer over its active host, relative to the layer; hides one with no visible host. */
  private layout(): void {
    if (this.destroyed) return;
    const base = this.root.getBoundingClientRect();
    for (const viewer of this.viewers.values()) {
      const style = viewer.iframe.style;
      const rect = pickActiveHost(viewer.hosts)?.el.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) {
        style.visibility = "hidden";
        continue;
      }
      style.visibility = "";
      style.transform = `translate(${rect.left - base.left}px, ${rect.top - base.top}px)`;
      style.width = `${rect.width}px`;
      style.height = `${rect.height}px`;
    }
  }
}

/** The arena's layer: undefined outside an arena (the view renders its own iframe), null until it mounts. */
export const ViewerLayerContext = createContext<ViewerLayer | null | undefined>(undefined);

/** True under the focus overlay: those hosts stay mounted but give up their viewer. */
export const ViewerConcealedContext = createContext(false);
