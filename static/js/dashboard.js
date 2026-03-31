'use strict';

const UPI_ID = 'yourname@upi';
const STORE  = 'SmartBill Store';

const BUILTIN = [
  {barcode:'8902030401232',name:'Parle-G Biscuits',        price:10, category:'Snacks',       unit:'100g', gst_rate:5},
  {barcode:'8901030863013',name:'Maggi 2-Min Noodles',     price:14, category:'Grocery',      unit:'70g',  gst_rate:5},
  {barcode:'8901233003049',name:'Amul Butter',             price:58, category:'Dairy',        unit:'100g', gst_rate:12},
  {barcode:'8906000510012',name:'Aavin Full Cream Milk',   price:32, category:'Dairy',        unit:'500ml',gst_rate:0},
  {barcode:'8906005111066',name:'Sprite',                  price:40, category:'Beverage',     unit:'750ml',gst_rate:12},
  {barcode:'8901719100025',name:'Classmate Notebook',      price:45, category:'Stationery',   unit:'200pg',gst_rate:12},
  {barcode:'8906001301038',name:'Tata Salt',               price:24, category:'Grocery',      unit:'1kg',  gst_rate:5},
  {barcode:'8901030000255',name:'Britannia Good Day',      price:30, category:'Snacks',       unit:'150g', gst_rate:5},
  {barcode:'8901063150348',name:'Colgate Toothpaste',      price:89, category:'Personal Care',unit:'150g', gst_rate:18},
  {barcode:'8901764000012',name:'Dettol Handwash',         price:99, category:'Personal Care',unit:'200ml',gst_rate:18},
  {barcode:'8906006690013',name:"Lay's Classic Salted",    price:20, category:'Snacks',       unit:'50g',  gst_rate:18},
  {barcode:'8901063040019',name:'Colgate Toothbrush',      price:65, category:'Personal Care',unit:'1pc',  gst_rate:18},
  {barcode:'8901906007373',name:'Tata Tea Premium',        price:62, category:'Grocery',      unit:'100g', gst_rate:5},
  {barcode:'8901719103453',name:'Classmate Pencil',        price:5,  category:'Stationery',   unit:'1pc',  gst_rate:12},
  {barcode:'RICE1KG',      name:'India Gate Basmati Rice', price:85, category:'Grocery',      unit:'1kg',  gst_rate:5},
];

let products=[...BUILTIN], cart={}, qrI=null, phoneQRI=null;
let billNo=mkBill(), socket=null, sid='smartbill';

/* ═══════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('bill-no').textContent = billNo;
  loadNgrok();        // restore saved ngrok URL
  loadProducts();
  buildPills();
  connectWS();
  document.getElementById('mi').addEventListener('keydown', e => {
    if (e.key === 'Enter') manualAdd();
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') generateBill();
  });
});

/* ═══════════════════════════════════════════════
   NGROK URL — save/load/get
   ═══════════════════════════════════════════════ */
function loadNgrok() {
  try {
    const saved = localStorage.getItem('sb_ngrok') || '';
    if (saved) {
      const el = document.getElementById('ngrok-url');
      el.value = saved;
      el.classList.add('set');
    }
  } catch {}
}

function onNgrokInput() {
  const el  = document.getElementById('ngrok-url');
  const val = el.value.trim();

  // Save to localStorage
  try { localStorage.setItem('sb_ngrok', val); } catch {}

  // Visual feedback
  if (val) {
    el.classList.add('set');
    const saved = document.getElementById('ngrok-saved');
    saved.classList.add('show');
    clearTimeout(saved._t);
    saved._t = setTimeout(() => saved.classList.remove('show'), 2000);
  } else {
    el.classList.remove('set');
  }
}

function getNgrokBase() {
  const raw = document.getElementById('ngrok-url').value.trim();
  if (!raw) return null;
  // Clean the URL — remove trailing slash
  return raw.replace(/\/+$/, '');
}

function getScannerUrl() {
  const base = getNgrokBase();
  if (base) return base + '/scanner';
  return window.location.origin + '/scanner';
}

/* ═══════════════════════════════════════════════
   QR MODAL
   ═══════════════════════════════════════════════ */
function showQR() {
  const base    = getNgrokBase();
  const scanUrl = base ? base + '/scanner' : null;
  const noNgrok = document.getElementById('modal-no-ngrok');
  const qrSec   = document.getElementById('modal-qr-section');
  const desc    = document.getElementById('modal-desc');

  if (!base) {
    // No ngrok — show instructions
    noNgrok.style.display = 'block';
    qrSec.style.display   = 'none';
    desc.textContent = 'Set up ngrok first to access the scanner from your phone.';
    document.getElementById('qr-modal').classList.add('show');
    return;
  }

  // ngrok URL is set — generate QR
  noNgrok.style.display = 'none';
  qrSec.style.display   = 'block';
  desc.textContent = 'Scan this with your phone camera to open the barcode scanner.';
  document.getElementById('modal-url-text').textContent = scanUrl;

  const div = document.getElementById('modal-qr');
  div.innerHTML = '';
  if (phoneQRI) { try { phoneQRI.clear(); } catch {} }
  phoneQRI = new QRCode(div, {
    text:         scanUrl,
    width:        200,
    height:       200,
    colorDark:    '#312e81',
    colorLight:   '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });

  document.getElementById('qr-modal').classList.add('show');
  toast(`QR ready — scanner: ${scanUrl}`, 'ok');
}

function closeQR() {
  document.getElementById('qr-modal').classList.remove('show');
}

/* ═══════════════════════════════════════════════
   WEBSOCKET
   ═══════════════════════════════════════════════ */
function connectWS() {
  sid = (document.getElementById('sid').value || 'smartbill').trim();
  if (socket) socket.disconnect();

  /* Connect to ngrok URL if set, otherwise local */
  const base   = getNgrokBase();
  const wsUrl  = base || window.location.origin;

  socket = io(wsUrl, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });

  socket.on('connect', () => {
    console.log('[WS] connected to', wsUrl);
    socket.emit('join_session', { session_id: sid, role: 'laptop' });
    setPhone(false, 'Waiting for phone…', 'Open /scanner on your phone to connect');
  });

  socket.on('disconnect', () => {
    setPhone(false, 'Disconnected', 'Refresh to reconnect');
  });

  socket.on('connect_error', (err) => {
    console.error('[WS] error:', err.message);
    setPhone(false, 'Connection failed', 'Check ngrok is running and URL is correct');
  });

  /* ★ MAIN EVENT: phone scanned a barcode → add to bill */
  socket.on('barcode_received', (data) => {
    const code = data.barcode;
    console.log('[WS] barcode received:', code);

    // Flash green indicator bar
    const ind = document.getElementById('scan-ind');
    document.getElementById('si-text').textContent = `📱 Phone scanned: ${code}`;
    ind.classList.add('flash');
    clearTimeout(ind._t);
    ind._t = setTimeout(() => ind.classList.remove('flash'), 2000);

    // Look up and add to cart
    lookupProduct(code);
  });

  socket.on('phone_status', (data) => {
    if (data.status === 'camera_on') {
      setPhone(true, '📱 Phone camera active', 'Scan barcodes → products appear here instantly');
    } else {
      setPhone(false, 'Phone connected', 'Camera off on phone');
    }
  });
}

function setPhone(on, lbl, sub) {
  const led = document.getElementById('phone-led');
  on ? led.classList.add('on') : led.classList.remove('on');
  document.getElementById('phone-lbl').textContent = lbl;
  document.getElementById('phone-sub').textContent = sub;
}

/* ═══════════════════════════════════════════════
   LOAD PRODUCTS
   ═══════════════════════════════════════════════ */
async function loadProducts() {
  try {
    const r = await fetch('/api/products', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw 0;
    const data = await r.json();
    data.forEach(sp => {
      const i = products.findIndex(p => p.barcode === sp.barcode);
      if (i >= 0) products[i] = sp; else products.push(sp);
    });
    buildPills();
    setSpill('online', 'Server online');
    showBanner('ok', `✓ Connected — ${data.length} products loaded`);
    setTimeout(hideBanner, 3000);
  } catch {
    buildPills();
    setSpill('offline', 'Offline');
    showBanner('warn', '⚠ Server not reachable — run: python app.py');
  }
}

/* ═══════════════════════════════════════════════
   PRODUCT LOOKUP
   ═══════════════════════════════════════════════ */
async function lookupProduct(bc) {
  const local = products.find(p => p.barcode === bc);
  if (local) { showFound(local); addToCart(local); return; }
  try {
    const r = await fetch(`/api/product/${encodeURIComponent(bc)}`,
                          { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      products.push(d.product);
      showFound(d.product);
      addToCart(d.product);
      return;
    }
  } catch {}
  showNF(bc);
}

function showFound(p) {
  const el = document.getElementById('sf');
  el.className = 'scan-flash found show';
  document.getElementById('sf-name').textContent  = p.name;
  document.getElementById('sf-meta').textContent  = `${p.category} · ${p.unit} · GST ${p.gst_rate}%`;
  document.getElementById('sf-price').textContent = `₹${parseFloat(p.price).toFixed(2)}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 4000);
}

function showNF(bc) {
  const el = document.getElementById('sf');
  el.className = 'scan-flash notfound show';
  document.getElementById('sf-name').textContent  = `Not found: ${bc}`;
  document.getElementById('sf-meta').textContent  = 'Add this product at the Products page';
  document.getElementById('sf-price').textContent = '';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 5000);
  toast(`${bc} not in database`, 'warn');
}

/* ═══════════════════════════════════════════════
   MANUAL INPUT
   ═══════════════════════════════════════════════ */
function manualAdd() {
  const v = document.getElementById('mi').value.trim();
  if (!v) return;
  document.getElementById('mi').value = '';
  const e = products.find(p => p.barcode === v);
  if (e) { showFound(e); addToCart(e); return; }
  const n = products.filter(p => p.name.toLowerCase().includes(v.toLowerCase()));
  if (n.length) { showFound(n[0]); addToCart(n[0]); return; }
  lookupProduct(v);
}

/* ═══════════════════════════════════════════════
   CART
   ═══════════════════════════════════════════════ */
function addToCart(p) {
  const bc = p.barcode;
  if (cart[bc]) cart[bc].qty++;
  else cart[bc] = { p: {...p}, qty: 1 };
  renderCart();
  toast(`+ ${p.name}`, 'ok');
}

function changeQty(bc, d) {
  if (!cart[bc]) return;
  cart[bc].qty += d;
  if (cart[bc].qty <= 0) delete cart[bc];
  renderCart();
}

function removeItem(bc) { delete cart[bc]; renderCart(); }

function renderCart() {
  const keys = Object.keys(cart);
  document.getElementById('empty-cart').style.display  = keys.length ? 'none'  : 'flex';
  document.getElementById('cart-table').style.display  = keys.length ? 'table' : 'none';

  let sub = 0, gst = 0, qty = 0;

  document.getElementById('cart-body').innerHTML = keys.map(bc => {
    const { p, qty: q } = cart[bc];
    const base = parseFloat(p.price) * q;
    sub += base; gst += base * (p.gst_rate / 100); qty += q;
    const [col, bg] = catStyle(p.category);
    return `<tr>
      <td>
        <div class="prod-name">${esc(p.name)}</div>
        <div class="prod-code">${esc(p.barcode)}</div>
      </td>
      <td>
        <span class="cat-badge" style="color:${col};border-color:${col}44;background:${bg}">
          ${esc(p.category)}
        </span>
      </td>
      <td class="price-cell">₹${parseFloat(p.price).toFixed(2)}</td>
      <td>
        <div class="qty-controls">
          <button class="qty-btn" onclick="changeQty('${esc(bc)}',-1)">−</button>
          <span class="qty-num">${q}</span>
          <button class="qty-btn" onclick="changeQty('${esc(bc)}',1)">+</button>
        </div>
      </td>
      <td class="gst-cell">${p.gst_rate}%</td>
      <td class="total-cell">₹${base.toFixed(2)}</td>
      <td><button class="del-btn" onclick="removeItem('${esc(bc)}')">✕</button></td>
    </tr>`;
  }).join('');

  const grand = sub + gst;
  document.getElementById('t-sub').textContent   = `₹${sub.toFixed(2)}`;
  document.getElementById('t-gst').textContent   = `₹${gst.toFixed(2)}`;
  document.getElementById('t-grand').textContent = `₹${grand.toFixed(2)}`;
  document.getElementById('ic').textContent = keys.length;
  document.getElementById('iq').textContent = qty;
}

/* ═══════════════════════════════════════════════
   GENERATE BILL
   ═══════════════════════════════════════════════ */
async function generateBill() {
  const keys = Object.keys(cart);
  if (!keys.length) { toast('Add items first', 'warn'); return; }

  let sub = 0, gst = 0;
  const items = keys.map(bc => {
    const { p, qty } = cart[bc];
    const base = parseFloat(p.price) * qty;
    sub += base; gst += base * (p.gst_rate / 100);
    return { name:p.name, price:parseFloat(p.price), qty, gst_rate:p.gst_rate, unit:p.unit, barcode:p.barcode };
  });
  const grand = sub + gst;

  renderQR(grand);
  fetch('/api/analytics/record_sale', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  }).catch(() => {});

  printBill(items, sub, gst, grand);
}

function printBill(items, sub, gst, grand) {
  const upi = `upi://pay?pa=${UPI_ID}&pn=${encodeURIComponent(STORE)}&am=${grand.toFixed(2)}&cu=INR&tn=${billNo}`;
  const dt  = new Date().toLocaleString('en-IN', {
    day:'2-digit', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit', hour12:true,
  });

  const rows = items.map((it, i) => `<tr>
    <td class="tc">${i+1}</td>
    <td><b>${esc(it.name)}</b><br/><span class="sm">${esc(it.unit)}</span></td>
    <td class="tc">${it.qty}</td>
    <td class="tr">₹${it.price.toFixed(2)}</td>
    <td class="tc">${it.gst_rate}%</td>
    <td class="tr"><b>₹${(it.price*it.qty).toFixed(2)}</b></td>
  </tr>`).join('');

  const win = window.open('', '_blank');
  if (!win) { toast('Allow pop-ups for this site!', 'bad'); return; }

  win.document.write(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"/><title>Bill ${billNo}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
@page{size:A4;margin:12mm 14mm}
body{font-family:'Plus Jakarta Sans',sans-serif;font-size:13px;color:#0f172a;background:#fff}
.w{max-width:740px;margin:0 auto;padding:28px}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;
  padding-bottom:16px;border-bottom:3px solid #6366f1;margin-bottom:20px}
.sn{font-size:26px;font-weight:800;background:linear-gradient(135deg,#6366f1,#8b5cf6);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.ss{font-size:11px;color:#94a3b8;margin-top:2px}
.bi{text-align:right}
.bn{font-size:14px;font-weight:700}
.bd{font-size:11px;color:#64748b;font-family:monospace}
.badge{display:inline-block;margin-top:5px;padding:3px 10px;background:#f5f3ff;
  color:#6366f1;border:1px solid #c4b5fd;border-radius:20px;
  font-size:10px;font-weight:700;text-transform:uppercase}
table{width:100%;border-collapse:collapse;margin-bottom:18px}
thead th{background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;
  padding:10px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase}
td{padding:10px 12px;border-bottom:1px solid #e8ecf0;vertical-align:middle}
tr:nth-child(even) td{background:#faf5ff}
.tc{text-align:center}.tr{text-align:right}.sm{font-size:11px;color:#94a3b8}
.tots{display:flex;justify-content:flex-end;margin-bottom:20px}
.tb{width:268px;border:1.5px solid #c4b5fd;border-radius:12px;overflow:hidden;
  background:linear-gradient(135deg,#f8faff,#f5f3ff)}
.tr2{display:flex;justify-content:space-between;padding:9px 16px;
  border-bottom:1px solid #e9d5ff;font-size:13px}
.tr2:last-child{border-bottom:none}
.lb{color:#64748b}.vl{font-weight:700;font-family:monospace}
.gr{background:linear-gradient(135deg,#6366f1,#4f46e5);font-weight:800;font-size:15px}
.gr .lb,.gr .vl{color:#fff}
.pay{display:flex;gap:22px;align-items:center;padding:18px;
  background:linear-gradient(135deg,#f8faff,#f5f3ff);
  border:1.5px solid #c4b5fd;border-radius:14px;margin-bottom:20px}
.qbox{background:#fff;padding:10px;border:1.5px solid #c4b5fd;border-radius:10px;flex-shrink:0}
.pt{font-size:15px;font-weight:800;margin-bottom:5px}
.pa{font-size:24px;font-weight:900;background:linear-gradient(135deg,#6366f1,#8b5cf6);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  font-family:monospace;margin-bottom:5px}
.pu{font-size:11px;color:#94a3b8;font-family:monospace;margin-bottom:10px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{padding:4px 11px;background:#fff;border:1px solid #c4b5fd;
  border-radius:20px;font-size:11px;font-weight:600;color:#6366f1}
.foot{text-align:center;padding-top:14px;border-top:1px solid #e9d5ff}
.ty{font-size:14px;font-weight:800;background:linear-gradient(135deg,#6366f1,#8b5cf6);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;
  background-clip:text;margin-bottom:3px}
.fs{font-size:10px;color:#94a3b8}
.pbar{position:fixed;top:0;left:0;right:0;z-index:99;
  background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;
  padding:12px 24px;display:flex;align-items:center;justify-content:space-between}
.pt2{font-size:14px;font-weight:700}.ps2{font-size:12px;opacity:.75}
.pb{background:#fff;color:#6366f1;border:none;padding:9px 22px;
  border-radius:10px;font-size:14px;font-weight:800;cursor:pointer}
.sp{height:54px}
@media print{.pbar,.sp{display:none!important}.w{padding:0}}
</style></head><body>
<div class="pbar">
  <div><div class="pt2">Bill – ${billNo}</div><div class="ps2">Total: ₹${grand.toFixed(2)}</div></div>
  <button class="pb" onclick="window.print()">🖨 Print Bill</button>
</div>
<div class="sp"></div>
<div class="w">
<div class="hdr">
  <div><div class="sn">${STORE}</div><div class="ss">Auto Billing System · SmartBill Pro</div></div>
  <div class="bi">
    <div class="bn">Bill No: ${billNo}</div>
    <div class="bd">${dt}</div>
    <span class="badge">Tax Invoice</span>
  </div>
</div>
<table><thead><tr>
  <th class="tc" style="width:36px">#</th><th>Product</th>
  <th class="tc" style="width:50px">Qty</th>
  <th class="tr" style="width:86px">Rate</th>
  <th class="tc" style="width:58px">GST%</th>
  <th class="tr" style="width:96px">Amount</th>
</tr></thead><tbody>${rows}</tbody></table>
<div class="tots"><div class="tb">
  <div class="tr2"><span class="lb">Subtotal</span><span class="vl">₹${sub.toFixed(2)}</span></div>
  <div class="tr2"><span class="lb">GST</span><span class="vl">₹${gst.toFixed(2)}</span></div>
  <div class="tr2 gr"><span class="lb">Grand Total</span><span class="vl">₹${grand.toFixed(2)}</span></div>
</div></div>
<div class="pay">
  <div class="qbox"><div id="qr" style="width:110px;height:110px"></div></div>
  <div>
    <div class="pt">Scan to Pay</div>
    <div class="pa">₹${grand.toFixed(2)}</div>
    <div class="pu">${UPI_ID}</div>
    <div class="chips">
      <span class="chip">📱 PhonePe</span>
      <span class="chip">💳 GPay</span>
      <span class="chip">🏦 Paytm</span>
      <span class="chip">Any UPI</span>
    </div>
  </div>
</div>
<div class="foot">
  <div class="ty">Thank you for shopping with us!</div>
  <div class="fs">Generated by SmartBill Pro · ${dt}</div>
</div></div>
<script>
new QRCode(document.getElementById('qr'),{
  text:"${upi}",width:110,height:110,
  colorDark:"#312e81",colorLight:"#fff",correctLevel:QRCode.CorrectLevel.M
});
setTimeout(()=>window.print(),700);
<\/script></body></html>`);
  win.document.close();
  toast('Print dialog opening…', 'ok');
}

/* ═══════════════════════════════════════════════
   QR IN-PAGE (UPI payment)
   ═══════════════════════════════════════════════ */
function renderQR(amount) {
  const upi = `upi://pay?pa=${UPI_ID}&pn=${encodeURIComponent(STORE)}&am=${amount.toFixed(2)}&cu=INR&tn=${billNo}`;
  const div = document.getElementById('qr-canvas');
  div.innerHTML = '';
  try {
    if (qrI) { try { qrI.clear(); } catch {} }
    qrI = new QRCode(div, {
      text: upi, width: 120, height: 120,
      colorDark: '#312e81', colorLight: '#fff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch { div.textContent = upi; }
  document.getElementById('qr-amount').textContent = `₹${amount.toFixed(2)}`;
  document.getElementById('qr-ref').textContent    = billNo;
  document.getElementById('qr-zone').classList.add('show');
}

/* ═══════════════════════════════════════════════
   QUICK PILLS
   ═══════════════════════════════════════════════ */
function buildPills() {
  document.getElementById('pills').innerHTML =
    products.slice(0, 8).map(p =>
      `<div class="q-pill" onclick="qAdd('${esc(p.barcode)}')">${esc(p.name)}</div>`
    ).join('');
}
function qAdd(bc) {
  const p = products.find(x => x.barcode === bc);
  if (p) { showFound(p); addToCart(p); }
}

/* ═══════════════════════════════════════════════
   CLEAR BILL
   ═══════════════════════════════════════════════ */
function clearBill() {
  cart = {}; billNo = mkBill();
  document.getElementById('bill-no').textContent = billNo;
  document.getElementById('qr-zone').classList.remove('show');
  document.getElementById('sf').classList.remove('show');
  renderCart();
  toast('Cart cleared', 'ok');
}

/* ═══════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════ */
function setSpill(t, l) {
  const p = document.getElementById('spill');
  p.className = `status-pill ${t}`;
  p.querySelector('span:last-child').textContent = l;
}
function showBanner(t, h) {
  const b = document.getElementById('banner');
  b.className = `banner show ${t}`;
  b.innerHTML = h;
}
function hideBanner() {
  document.getElementById('banner').classList.remove('show');
}
function mkBill() {
  const d = new Date(), z = n => String(n).padStart(2,'0');
  return `BILL-${d.getFullYear()}${z(d.getMonth()+1)}${z(d.getDate())}-${Math.floor(Math.random()*9000+1000)}`;
}
function catStyle(c) {
  const m = {
    Grocery:       ['#059669','#ecfdf5'],
    Dairy:         ['#d97706','#fffbeb'],
    Snacks:        ['#7c3aed','#f5f3ff'],
    Beverage:      ['#0891b2','#ecfeff'],
    Stationery:    ['#6366f1','#eef2ff'],
    'Personal Care':['#db2777','#fdf2f8'],
  };
  return m[c] || ['#64748b','#f8fafc'];
}
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function toast(msg, type='ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}
