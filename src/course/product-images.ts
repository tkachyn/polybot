import type { ShopProduct } from "./shop-catalogue.js";

// Product photos for the arena-shop storefront, drawn as SVG studio shots.
// Each listing gets its own drive: the series picks the body shape, the brand
// picks the finish, and the capacity is printed on the case. Pages embed them
// as CSS background images, so the store needs no external assets and the
// text printed on a drive stays out of the page text agents read.

type Form = "bar" | "rugged" | "stick" | "pro" | "card";

type Finish = { light: string; dark: string; edge: string; ink: string; accent: string };

const FORMS: Record<string, Form> = {
  X1: "bar", Swift: "bar", Pulse: "bar",
  Go: "card", Flex: "card",
  Pro: "pro", Edge: "pro",
  Rugged: "rugged", Shield: "rugged",
  Mini: "stick", Pocket: "stick", Nano: "stick",
};

const FINISHES: Record<string, Finish> = {
  Kinetic: { light: "#d23a33", dark: "#8c1b17", edge: "#5a100d", ink: "#ffffff", accent: "#2a2a2a" },
  Lumen: { light: "#fbfbfc", dark: "#cdd1d7", edge: "#9ea5af", ink: "#2b2f36", accent: "#3b82f6" },
  Northpeak: { light: "#3d5c49", dark: "#1b2d23", edge: "#0f1a14", ink: "#e8efe9", accent: "#d97706" },
  Vaultline: { light: "#4a4e55", dark: "#1c1e21", edge: "#0c0d0f", ink: "#dfe2e6", accent: "#e11d48" },
  Arcwave: { light: "#3a71c2", dark: "#17376b", edge: "#0d2146", ink: "#ffffff", accent: "#111827" },
  Tidewater: { light: "#33a0a0", dark: "#175a5c", edge: "#0c3637", ink: "#ffffff", accent: "#f59e0b" },
  Photon: { light: "#45464a", dark: "#1a1a1c", edge: "#080809", ink: "#ffffff", accent: "#f26b1d" },
  Sable: { light: "#2e3034", dark: "#0f1012", edge: "#040405", ink: "#cfae6e", accent: "#cfae6e" },
  Quanta: { light: "#a3a8b0", dark: "#5c616a", edge: "#383b41", ink: "#ffffff", accent: "#7c3aed" },
  Ironclad: { light: "#595c62", dark: "#2a2c30", edge: "#16171a", ink: "#ffffff", accent: "#f2c230" },
  Helix: { light: "#e6e9ed", dark: "#a9b0ba", edge: "#7a828e", ink: "#1f2937", accent: "#0ea5c9" },
  Nimbus: { light: "#c6dcef", dark: "#7fa3c4", edge: "#557798", ink: "#1b2a3a", accent: "#1e3a5f" },
};

const FALLBACK_FINISH = FINISHES.Vaultline;
const STUDIO = "#eef0f3";
const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";

function formOf(product: ShopProduct): Form {
  const series = product.name.slice(product.brand.length).trim().split(" ")[0] ?? "";
  return FORMS[series] ?? "bar";
}

function box(x: number, y: number, w: number, h: number, r: number, fill: string, extra = ""): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${extra}/>`;
}

/** The shared studio: background, floor shadow, and the body's gradients. */
function studio(finish: Finish, shadowWidth: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360">
<defs>
<radialGradient id="bg" cx="50%" cy="42%" r="70%"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${STUDIO}"/></radialGradient>
<linearGradient id="body" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${finish.light}"/><stop offset="1" stop-color="${finish.dark}"/></linearGradient>
<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".34"/><stop offset=".45" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f5f7"/><stop offset=".5" stop-color="#b9bec6"/><stop offset="1" stop-color="#8b919a"/></linearGradient>
<filter id="blur" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="9"/></filter>
</defs>
<rect width="480" height="360" fill="url(#bg)"/>
<g transform="translate(240 180) scale(1.28) translate(-240 -180)">
<ellipse cx="244" cy="284" rx="${shadowWidth}" ry="15" fill="#0b1220" opacity=".22" filter="url(#blur)"/>
<g transform="rotate(-7 240 180)">${body}</g>
</g>
</svg>`;
}

/** Case, side wall, sheen and edge highlight for one rounded slab. */
function slab(x: number, y: number, w: number, h: number, r: number, depth: number, finish: Finish): string {
  return [
    box(x, y + depth, w, h, r, finish.edge),
    box(x, y + depth / 2, w, h, r, finish.dark),
    box(x, y, w, h, r, "url(#body)"),
    box(x, y, w, h * 0.55, r, "url(#sheen)"),
    box(x + 1.5, y + 1.5, w - 3, h - 3, r - 1.5, "none", ' stroke="#fff" stroke-opacity=".28" stroke-width="1.5"'),
  ].join("");
}

function wordmark(x: number, y: number, text: string, size: number, fill: string, anchor = "middle"): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="700" letter-spacing="${(size * 0.18).toFixed(1)}" fill="${fill}" text-anchor="${anchor}">${text}</text>`;
}

function caption(x: number, y: number, text: string, size: number, fill: string, anchor = "middle"): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="500" fill="${fill}" fill-opacity=".72" text-anchor="${anchor}">${text}</text>`;
}

function usbPort(cx: number, cy: number): string {
  return box(cx - 15, cy - 4, 30, 8, 4, "#0a0a0b") + box(cx - 9, cy - 1, 18, 2, 1, "#5b6068");
}

function drawBar(product: ShopProduct, finish: Finish, brand: string, capacity: string): string {
  const [x, y, w, h] = [110, 102, 260, 158];
  return slab(x, y, w, h, 24, 16, finish) +
    box(x + w - 78, y + 12, 64, h - 24, 18, "#000", ' fill-opacity=".12"') +
    box(x + w - 77, y + 13, 62, h - 26, 17, "none", ' stroke="#fff" stroke-opacity=".18"') +
    wordmark(x + 26, y + h / 2 + 4, brand, 20, finish.ink, "start") +
    caption(x + 26, y + h / 2 + 30, `${capacity} · Portable SSD`, 12, finish.ink, "start") +
    `<circle cx="${x + w - 46}" cy="${y + 28}" r="3" fill="#7dd3fc"/>` +
    usbPort(x + w / 2, y + h + 9);
}

function drawRugged(product: ShopProduct, finish: Finish, brand: string, capacity: string): string {
  const [x, y, w, h] = [118, 92, 244, 176];
  const rubber = finish.accent;
  return box(x, y + 16, w, h, 34, "#000", ' fill-opacity=".35"') +
    box(x, y + 8, w, h, 34, rubber, ' fill-opacity=".85"') +
    box(x, y, w, h, 34, rubber) +
    box(x, y, w, h * 0.5, 34, "url(#sheen)") +
    // Carabiner loop through the top-left corner.
    `<circle cx="${x + 30}" cy="${y + 30}" r="15" fill="${STUDIO}"/>` +
    `<circle cx="${x + 30}" cy="${y + 30}" r="15" fill="none" stroke="#000" stroke-opacity=".25" stroke-width="2"/>` +
    slab(x + 18, y + 18, w - 36, h - 36, 22, 4, finish).replace(/^<rect[^>]*\/>/, "") +
    `<circle cx="${x + 30}" cy="${y + 30}" r="17" fill="${rubber}"/><circle cx="${x + 30}" cy="${y + 30}" r="10" fill="${STUDIO}"/>` +
    [0, 1, 2, 3, 4].map((i) => box(x + 5, y + 58 + i * 16, 5, 9, 2, "#000", ' fill-opacity=".22"')).join("") +
    [0, 1, 2, 3, 4].map((i) => box(x + w - 10, y + 58 + i * 16, 5, 9, 2, "#000", ' fill-opacity=".22"')).join("") +
    wordmark(x + w / 2 + 6, y + h / 2 + 4, brand, 19, finish.ink) +
    caption(x + w / 2 + 6, y + h / 2 + 28, capacity, 13, finish.ink) +
    usbPort(x + w / 2, y + h + 10);
}

function drawStick(product: ShopProduct, finish: Finish, brand: string, capacity: string): string {
  const [x, y, w, h] = [96, 138, 290, 90];
  return slab(x, y, w, h, 22, 12, finish) +
    box(x + w - 46, y, 46, h, 22, "url(#metal)") +
    box(x + w - 46, y, 22, h, 0, "url(#metal)") +
    box(x + w - 47, y + 6, 2, h - 12, 1, "#000", ' fill-opacity=".25"') +
    `<circle cx="${x + 26}" cy="${y + h / 2}" r="10" fill="${STUDIO}"/>` +
    `<circle cx="${x + 26}" cy="${y + h / 2}" r="10" fill="none" stroke="#000" stroke-opacity=".3" stroke-width="2"/>` +
    wordmark(x + 52, y + h / 2 + 2, brand, 17, finish.ink, "start") +
    caption(x + 52, y + h / 2 + 22, capacity, 11, finish.ink, "start") +
    `<circle cx="${x + w - 62}" cy="${y + 18}" r="2.5" fill="#86efac"/>`;
}

function drawPro(product: ShopProduct, finish: Finish, brand: string, capacity: string): string {
  const [x, y, w, h] = [116, 92, 248, 168];
  const fins = Array.from({ length: 9 }, (_, i) => {
    const fy = y + 20 + i * 15;
    return `<line x1="${x + 18}" y1="${fy}" x2="${x + 150}" y2="${fy}" stroke="#000" stroke-opacity=".28" stroke-width="3" stroke-linecap="round"/>` +
      `<line x1="${x + 18}" y1="${fy + 2.5}" x2="${x + 150}" y2="${fy + 2.5}" stroke="#fff" stroke-opacity=".16" stroke-width="1.5" stroke-linecap="round"/>`;
  }).join("");
  // The bolt marks Thunderbolt and USB4 drives only.
  const bolt = /thunderbolt|usb4/i.test(product.connection)
    ? `<path d="M${x + 206} ${y + 34} l-14 22 h10 l-6 18 l16 -24 h-10 z" fill="${finish.accent}"/>`
    : `<circle cx="${x + 206}" cy="${y + 30}" r="3" fill="${finish.accent}"/>`;
  return slab(x, y, w, h, 16, 24, finish) + fins + bolt +
    wordmark(x + w - 22, y + h - 40, brand, 15, finish.ink, "end") +
    caption(x + w - 22, y + h - 20, `${capacity} · ${product.connection}`, 10.5, finish.ink, "end") +
    usbPort(x + w / 2, y + h + 13);
}

function drawCard(product: ShopProduct, finish: Finish, brand: string, capacity: string): string {
  const [x, y, s] = [142, 78, 196];
  const ribs = Array.from({ length: 7 }, (_, i) =>
    box(x + 22, y + 112 + i * 9, s - 44, 3, 1.5, "#000", ' fill-opacity=".16"')).join("");
  return slab(x, y, s, s, 30, 12, finish) + ribs +
    wordmark(x + s / 2, y + 62, brand, 18, finish.ink) +
    caption(x + s / 2, y + 84, capacity, 12, finish.ink) +
    `<circle cx="${x + s - 26}" cy="${y + 24}" r="3" fill="${finish.accent}"/>` +
    usbPort(x + s / 2, y + s + 7);
}

const DRAW: Record<Form, (product: ShopProduct, finish: Finish, brand: string, capacity: string) => string> = {
  bar: drawBar, rugged: drawRugged, stick: drawStick, pro: drawPro, card: drawCard,
};

const SHADOW: Record<Form, number> = { bar: 150, rugged: 145, stick: 160, pro: 150, card: 115 };

/** The product's studio shot as an SVG document. */
export function productImageSvg(product: ShopProduct): string {
  const finish = FINISHES[product.brand] ?? FALLBACK_FINISH;
  const form = formOf(product);
  const brand = product.brand.toUpperCase().replace(/[^A-Z0-9 ]/g, "");
  const capacity = product.capacityLabel.replace(/[^A-Za-z0-9 ]/g, "");
  return studio(finish, SHADOW[form], DRAW[form](product, finish, brand, capacity));
}

const cache = new Map<string, string>();

/** A CSS url(...) value for the product's image, safe inside a double-quoted attribute. */
export function productImageCss(product: ShopProduct): string {
  const key = `${product.id}|${product.name}|${product.capacityLabel}`;
  let value = cache.get(key);
  if (value === undefined) {
    const svg = productImageSvg(product).replace(/\n/g, "");
    value = `url(&quot;data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, "%27")}&quot;)`;
    cache.set(key, value);
  }
  return value;
}
