import {
  SHOP_SHIPPING_METHODS,
  SHOP_STORE_NAME,
  formatPrice,
  hashString,
  type ShippingMethod,
  type ShopProduct,
} from "./shop-catalogue.js";

// Server-rendered HTML for the arena-shop storefront. Plain links and forms,
// no client script: every link and form carries the run identity, and every
// page marks its main call to action data-arena-role="primary-action".

/** Run identity and proof, carried by every link (query) and form (hidden fields). */
export type RunParams = Record<string, string>;

export type PageFrame = {
  run: RunParams;
  cartCount: number;
};

export type CartLine = { product: ShopProduct; quantity: number };

export type ShopOrder = {
  number: string;
  name: string;
  address: string;
  shipping: ShippingMethod;
  lines: CartLine[];
  totalCents: number;
};

export type CheckoutForm = { name: string; address: string; shipping: string };

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A same-origin URL carrying the run identity, escaped for an attribute. */
function href(path: string, run: RunParams, extra: Record<string, string> = {}): string {
  return escapeHtml(`${path}?${new URLSearchParams({ ...run, ...extra }).toString()}`);
}

function hiddenFields(run: RunParams, extra: Record<string, string> = {}): string {
  return Object.entries({ ...run, ...extra })
    .map(([name, value]) =>
      `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
}

function withCommas(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function lineTotal(lines: readonly CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);
}

function itemCount(lines: readonly CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

function shippingMethod(value: string) {
  return SHOP_SHIPPING_METHODS.find((method) => method.value === value) ?? SHOP_SHIPPING_METHODS[0];
}

function thumb(product: ShopProduct, size = ""): string {
  const hue = hashString(product.id) % 360;
  return `<div class="thumb ${size}" style="--hue:${hue}" aria-hidden="true">${escapeHtml(product.capacityLabel)}</div>`;
}

function conditionBadge(product: ShopProduct): string {
  return product.condition === "refurbished"
    ? '<span class="badge badge-refurb">Condition: Refurbished</span>'
    : '<span class="badge">Condition: New</span>';
}

function priceBlock(product: ShopProduct): string {
  const list = product.listPriceCents === undefined
    ? ""
    : ` <s>List price: ${formatPrice(product.listPriceCents)}</s>`;
  return `<p class="price">Price: <strong>${formatPrice(product.priceCents)}</strong>${list}</p>`;
}

function continueShopping(run: RunParams): string {
  return `<form method="get" action="/">${hiddenFields(run)}<button type="submit" class="btn btn-primary" data-arena-role="primary-action">Continue shopping</button></form>`;
}

const STYLES = `
:root { color-scheme: light; --ink: #16181d; --muted: #5b6270; --line: #e3e6ec; --bg: #f6f7f9; --brand: #0f6ad8; --danger: #b42318; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); line-height: 1.5; }
a { color: var(--brand); }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 12px; }
.promo { background: #101828; color: #fff; text-align: center; font-size: .85rem; padding: 8px 16px; }
.site-header { display: flex; align-items: center; gap: 24px; padding: 14px 32px; background: #fff; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.logo { font-weight: 800; font-size: 1.35rem; color: var(--ink); text-decoration: none; letter-spacing: -.02em; }
.logo span { color: var(--brand); }
.nav { display: flex; gap: 18px; flex: 1; flex-wrap: wrap; }
.nav a { color: var(--muted); text-decoration: none; font-weight: 500; }
.cart-link { text-decoration: none; font-weight: 600; padding: 8px 14px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink); }
main { max-width: 1120px; margin: 0 auto; padding: 28px 32px 48px; }
.hero { background: linear-gradient(135deg, #0f6ad8, #5b3fd6); color: #fff; border-radius: 20px; padding: 40px; margin-bottom: 32px; }
.hero h1 { font-size: 2rem; margin: 6px 0; }
.eyebrow { text-transform: uppercase; letter-spacing: .12em; font-size: .75rem; font-weight: 700; margin: 0; opacity: .85; }
.search { display: flex; gap: 10px; margin: 18px 0 0; max-width: 640px; }
.search input { flex: 1; padding: 12px 14px; border-radius: 10px; border: 1px solid #cfd4dc; font: inherit; }
button { font: inherit; cursor: pointer; }
.btn { display: inline-flex; align-items: center; justify-content: center; padding: 12px 22px; border-radius: 10px; border: 0; font-weight: 700; text-decoration: none; }
.btn-primary { background: #ffb400; color: #16181d; }
.btn-primary:hover { background: #f5a300; }
.btn-wide { width: 100%; margin-top: 12px; }
.link-button { background: none; border: 0; padding: 0; color: var(--brand); text-decoration: underline; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 18px; }
.card { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 6px; }
.card h2 { font-size: 1rem; margin: 6px 0 0; }
.card h2 a { color: var(--ink); text-decoration: none; }
.card h2 a:hover { color: var(--brand); text-decoration: underline; }
.thumb { aspect-ratio: 4 / 3; border-radius: 10px; display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 1.4rem; background: linear-gradient(135deg, hsl(var(--hue) 55% 42%), hsl(calc(var(--hue) + 40) 60% 28%)); }
.thumb.small { width: 72px; font-size: .8rem; }
.thumb.large { font-size: 2.6rem; }
.meta, .muted { color: var(--muted); font-size: .9rem; margin: 0; }
.price { font-size: 1.1rem; margin: 0; }
.price strong { font-size: 1.3rem; }
.price s { color: var(--muted); font-size: .85rem; margin-left: 6px; }
.badge { align-self: flex-start; font-size: .75rem; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: #ecfdf3; color: #067647; }
.badge-refurb { background: #fff4e5; color: #b54708; }
.rating { color: #b54708; font-size: .9rem; margin: 0; }
.crumbs { font-size: .9rem; color: var(--muted); margin: 0 0 16px; }
.results-head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin: 24px 0 16px; }
.product { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 32px; align-items: start; }
.panel, .summary { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 24px; }
.panel { margin-top: 24px; }
.specs { border-collapse: collapse; width: 100%; }
.specs th, .specs td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.lines { list-style: none; margin: 0; padding: 0; }
.line { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto auto; gap: 16px; align-items: center; background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin-bottom: 10px; }
.line p { margin: 0; }
.two-col { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 24px; align-items: start; }
.row { display: flex; justify-content: space-between; gap: 12px; margin: 6px 0; }
.total { font-weight: 800; border-top: 1px solid var(--line); padding-top: 10px; }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; font-weight: 600; }
.field input, .field select { font: inherit; font-weight: 400; padding: 11px 12px; border: 1px solid #cfd4dc; border-radius: 10px; background: #fff; }
.alert { border: 1px solid #fda29b; background: #fef3f2; color: var(--danger); border-radius: 12px; padding: 12px 16px; margin-bottom: 18px; }
.alert ul { margin: 6px 0 0; padding-left: 20px; }
.perks { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 32px; }
.perks div { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.site-footer { border-top: 1px solid var(--line); background: #fff; padding: 28px 32px; color: var(--muted); font-size: .9rem; }
.footer-cols { max-width: 1120px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 18px; }
.site-footer h2 { font-size: .85rem; text-transform: uppercase; letter-spacing: .08em; color: var(--ink); margin: 0 0 8px; }
.site-footer a { color: var(--muted); display: block; margin: 4px 0; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 760px) { .product, .two-col { grid-template-columns: 1fr; } .site-header, main { padding-left: 16px; padding-right: 16px; } }
`;

function layout(frame: PageFrame, title: string, main: string): string {
  const { run } = frame;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · ${SHOP_STORE_NAME}</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="promo">Storage week: up to 30% off selected drives · Free Standard shipping on every order</div>
  <header class="site-header">
    <a class="logo" href="${href("/", run)}" data-arena-role="home-link">Volt<span>mart</span></a>
    <nav class="nav" aria-label="Departments">
      <a href="${href("/shop/search", run, { q: "portable ssd" })}" data-arena-role="nav-link">Portable SSDs</a>
      <a href="${href("/shop/search", run, { q: "deals" })}" data-arena-role="nav-link">Deals</a>
      <a href="${href("/shop/help", run)}" data-arena-role="nav-link">Shipping &amp; returns</a>
      <a href="${href("/shop/help", run)}#support" data-arena-role="nav-link">Support</a>
    </nav>
    <a class="cart-link" href="${href("/shop/cart", run)}" data-arena-role="view-cart">Cart (${frame.cartCount})</a>
  </header>
  <main>
${main}
  </main>
  <footer class="site-footer">
    <div class="footer-cols">
      <div><h2>Shop</h2><a href="${href("/shop/search", run, { q: "" })}" data-arena-role="footer-link">All portable SSDs</a><a href="${href("/shop/search", run, { q: "deals" })}" data-arena-role="footer-link">Today's deals</a></div>
      <div><h2>Help</h2><a href="${href("/shop/help", run)}" data-arena-role="footer-link">Shipping &amp; returns</a><a href="${href("/shop/help", run)}#support" data-arena-role="footer-link">Contact support</a></div>
      <div><h2>${SHOP_STORE_NAME}</h2><p>Fast, reliable storage since 2009. Prices in US dollars.</p></div>
    </div>
  </footer>
</body>
</html>`;
}

function searchForm(run: RunParams, query: string, placeholder: string): string {
  return `<form class="search" method="get" action="/shop/search">${hiddenFields(run)}
      <input type="search" name="q" value="${escapeHtml(query)}" maxlength="100" autocomplete="off" placeholder="${escapeHtml(placeholder)}" aria-label="Search ${SHOP_STORE_NAME}" data-arena-role="search-input">
      <button type="submit" class="btn btn-primary" data-arena-role="primary-action">Search</button>
    </form>`;
}

function productCard(run: RunParams, product: ShopProduct, query?: string): string {
  const link = href("/shop/product", run, query === undefined ? { sku: product.id } : { sku: product.id, q: query });
  return `<article class="card">
      ${thumb(product)}
      <h2><a href="${link}" data-arena-role="product-link">${escapeHtml(product.name)}</a></h2>
      <p class="meta">Capacity: ${escapeHtml(product.capacityLabel)} · ${escapeHtml(product.connection)}</p>
      ${conditionBadge(product)}
      ${priceBlock(product)}
      <p class="rating">★ ${product.rating.toFixed(1)} (${withCommas(product.reviewCount)} reviews)</p>
      <p class="muted">Free Standard shipping</p>
    </article>`;
}

export function renderHome(frame: PageFrame, trending: readonly ShopProduct[]): string {
  return layout(frame, "Portable SSDs and storage", `    <section class="hero">
      <p class="eyebrow">Storage week</p>
      <h1>Fast, pocket-sized storage for everything</h1>
      <p>Up to 30% off selected portable SSDs. Free Standard shipping on every order.</p>
      ${searchForm(frame.run, "", "Search portable SSDs, brands or capacities")}
    </section>
    <section>
      <h2>Trending now</h2>
      <div class="grid">${trending.map((product) => productCard(frame.run, product)).join("")}</div>
    </section>
    <section class="perks">
      <div><strong>Free Standard shipping</strong><p class="muted">Arrives in 5–7 business days.</p></div>
      <div><strong>30-day returns</strong><p class="muted">Changed your mind? Send it back.</p></div>
      <div><strong>2-year warranty</strong><p class="muted">On every new drive we sell.</p></div>
    </section>`);
}

export function renderResults(frame: PageFrame, query: string, results: readonly ShopProduct[]): string {
  const heading = query.trim() === "" ? "All portable SSDs" : `Results for "${query}"`;
  const body = results.length === 0
    ? `<div class="panel"><h1>No results for "${escapeHtml(query)}"</h1>
      <p class="muted">Check the spelling, or browse every portable SSD we stock.</p>
      <a href="${href("/shop/search", frame.run, { q: "" })}" data-arena-role="browse-all">Browse all portable SSDs</a></div>`
    : `<div class="results-head"><h1>${escapeHtml(heading)}</h1><p class="muted">${results.length} results · Sorted by: Featured</p></div>
    <div class="grid">${results.map((product) => productCard(frame.run, product, query)).join("")}</div>`;
  return layout(frame, heading, `    <p class="crumbs"><a href="${href("/", frame.run)}" data-arena-role="breadcrumb">Home</a> › Search</p>
    ${searchForm(frame.run, query, "Refine your search")}
    ${body}`);
}

export function renderProduct(frame: PageFrame, product: ShopProduct, query?: string): string {
  const condition = product.condition === "refurbished"
    ? "Refurbished: inspected and tested, with a 90-day warranty"
    : "New: sealed in the original packaging, with a 2-year warranty";
  const back = query === undefined
    ? ""
    : `<p><a href="${href("/shop/search", frame.run, { q: query })}" data-arena-role="back-to-results">← Back to results</a></p>`;
  return layout(frame, product.name, `    <p class="crumbs"><a href="${href("/", frame.run)}" data-arena-role="breadcrumb">Home</a> › <a href="${href("/shop/search", frame.run, { q: "" })}" data-arena-role="breadcrumb">Portable SSDs</a> › ${escapeHtml(product.name)}</p>
    ${back}
    <div class="product">
      ${thumb(product, "large")}
      <div class="summary">
        <p class="meta">${escapeHtml(product.brand)}</p>
        <h1>${escapeHtml(product.name)}</h1>
        <p class="rating">★ ${product.rating.toFixed(1)} · ${withCommas(product.reviewCount)} reviews</p>
        ${priceBlock(product)}
        <p>Capacity: <strong>${escapeHtml(product.capacityLabel)}</strong></p>
        <p>Condition: <strong>${escapeHtml(condition)}</strong></p>
        <p class="muted">In stock · Ships in 1 business day · Free Standard shipping</p>
        <form method="post" action="/shop/cart/add">${hiddenFields(frame.run, { sku: product.id })}
          <button type="submit" class="btn btn-primary btn-wide" data-arena-role="primary-action">Add to cart</button>
        </form>
      </div>
    </div>
    <section class="panel">
      <h2>Specifications</h2>
      <table class="specs"><tbody>
        <tr><th>Brand</th><td>${escapeHtml(product.brand)}</td></tr>
        <tr><th>Capacity</th><td>${escapeHtml(product.capacityLabel)}</td></tr>
        <tr><th>Condition</th><td>${product.condition === "refurbished" ? "Refurbished" : "New"}</td></tr>
        <tr><th>Interface</th><td>${escapeHtml(product.connection)}</td></tr>
        <tr><th>Read speed</th><td>Up to ${withCommas(product.readMBps)} MB/s</td></tr>
        <tr><th>SKU</th><td>${escapeHtml(product.id)}</td></tr>
      </tbody></table>
    </section>`);
}

export function renderCart(frame: PageFrame, lines: readonly CartLine[]): string {
  if (lines.length === 0) {
    return layout(frame, "Your cart", `    <h1>Your cart</h1>
    <div class="panel"><p>Your cart is empty.</p>${continueShopping(frame.run)}</div>`);
  }
  const items = lines.map((line) => `<li class="line">
        ${thumb(line.product, "small")}
        <div><p><strong>${escapeHtml(line.product.name)}</strong></p><p class="muted">${escapeHtml(line.product.capacityLabel)} · ${line.product.condition === "refurbished" ? "Refurbished" : "New"} · Qty: ${line.quantity}</p></div>
        <p><strong>${formatPrice(line.product.priceCents * line.quantity)}</strong></p>
        <form method="post" action="/shop/cart/remove">${hiddenFields(frame.run, { sku: line.product.id })}<button type="submit" class="link-button" data-arena-role="remove-item">Remove<span class="sr-only"> ${escapeHtml(line.product.name)}</span></button></form>
      </li>`).join("");
  return layout(frame, "Your cart", `    <h1>Your cart</h1>
    <div class="two-col">
      <ul class="lines">${items}</ul>
      <aside class="summary">
        <div class="row"><span>Subtotal (${itemCount(lines)} ${itemCount(lines) === 1 ? "item" : "items"})</span><strong>${formatPrice(lineTotal(lines))}</strong></div>
        <p class="muted">Choose Standard (free) or Express shipping at checkout.</p>
        <form method="get" action="/shop/checkout">${hiddenFields(frame.run)}<button type="submit" class="btn btn-primary btn-wide" data-arena-role="primary-action">Checkout</button></form>
      </aside>
    </div>`);
}

export function renderCheckout(
  frame: PageFrame,
  lines: readonly CartLine[],
  form: CheckoutForm,
  errors: readonly string[],
): string {
  const alert = errors.length === 0
    ? ""
    : `<div class="alert" role="alert" data-arena-role="form-error"><strong>We couldn't place your order.</strong><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`;
  if (lines.length === 0) {
    return layout(frame, "Checkout", `    <h1>Checkout</h1>
    ${alert}<div class="panel"><p>Your cart is empty.</p>${continueShopping(frame.run)}</div>`);
  }
  const method = shippingMethod(form.shipping);
  const options = SHOP_SHIPPING_METHODS.map((option) =>
    `<option value="${option.value}"${option.value === method.value ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
  const subtotal = lineTotal(lines);
  return layout(frame, "Checkout", `    <h1>Checkout</h1>
    ${alert}
    <div class="two-col">
      <form class="panel" method="post" action="/shop/checkout">${hiddenFields(frame.run)}
        <h2>Shipping address</h2>
        <label class="field">Full name<input type="text" name="name" value="${escapeHtml(form.name)}" maxlength="120" autocomplete="name" aria-label="Full name" data-arena-role="shipping-name"></label>
        <label class="field">Address (street, city, state, ZIP)<input type="text" name="address" value="${escapeHtml(form.address)}" maxlength="200" autocomplete="street-address" aria-label="Shipping address" data-arena-role="shipping-address"></label>
        <h2>Delivery</h2>
        <label class="field">Shipping method<select name="shipping" aria-label="Shipping method" data-arena-role="shipping-method">${options}</select></label>
        <h2>Payment</h2>
        <p class="muted">Charged to the saved arena test card ending in 4242.</p>
        <button type="submit" class="btn btn-primary btn-wide" data-arena-role="primary-action">Place order</button>
      </form>
      <aside class="summary">
        <h2>Order summary</h2>
        ${lines.map((line) => `<div class="row"><span>${escapeHtml(line.product.name)} × ${line.quantity}</span><span>${formatPrice(line.product.priceCents * line.quantity)}</span></div>`).join("")}
        <div class="row"><span>Subtotal</span><span>${formatPrice(subtotal)}</span></div>
        <div class="row"><span>Shipping (${method.value === "standard" ? "Standard" : "Express"})</span><span>${method.costCents === 0 ? "Free" : formatPrice(method.costCents)}</span></div>
        <div class="row total"><span>Total</span><span>${formatPrice(subtotal + method.costCents)}</span></div>
      </aside>
    </div>`);
}

export function renderConfirmation(frame: PageFrame, order: ShopOrder): string {
  const method = shippingMethod(order.shipping);
  return layout(frame, `Order ${order.number}`, `    <div class="panel">
      <p class="eyebrow">Order confirmed</p>
      <h1>Thank you, ${escapeHtml(order.name)}. Your order is placed.</h1>
      <p>Order number: <strong id="order-number">${escapeHtml(order.number)}</strong></p>
      <p>Shipping to ${escapeHtml(order.name)}, ${escapeHtml(order.address)} · ${escapeHtml(method.label)}</p>
      <ul>${order.lines.map((line) => `<li>${escapeHtml(line.product.name)} × ${line.quantity} · ${formatPrice(line.product.priceCents * line.quantity)}</li>`).join("")}</ul>
      <p><strong>Total charged: ${formatPrice(order.totalCents)}</strong></p>
      ${continueShopping(frame.run)}
    </div>`);
}

export function renderNotFound(frame: PageFrame, heading: string, message: string): string {
  return layout(frame, heading, `    <div class="panel"><h1>${escapeHtml(heading)}</h1><p class="muted">${escapeHtml(message)}</p>${continueShopping(frame.run)}</div>`);
}

export function renderHelp(frame: PageFrame): string {
  return layout(frame, "Shipping and returns", `    <div class="panel">
      <h1>Shipping and returns</h1>
      <p><strong>Standard shipping</strong> is free on every order and arrives in 5–7 business days.</p>
      <p><strong>Express shipping</strong> costs $14.99 and arrives in 1–2 business days where available.</p>
      <p>New drives can be returned within 30 days. Refurbished drives carry a 90-day warranty.</p>
      <h2 id="support">Support</h2>
      <p>Our support team answers within one business day at support@voltmart.test.</p>
      ${continueShopping(frame.run)}
    </div>`);
}
