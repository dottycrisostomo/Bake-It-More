/* ==========================================================================
   Bake It More — live dashboard app logic
   Auth (Google Identity Services) + Drive fetch + XLSX parsing + orchestration.
   UI rendering lives in ui.js (shared render functions) — this file only
   produces the same-shaped data objects (SALES, FIN, INVENTORY, PRICELIST)
   that ui.js already knows how to draw.
   ========================================================================== */

let accessToken = null;
let tokenClient = null;
let refreshTimer = null;
const REFRESH_MS = 5 * 60 * 1000; // poll every 5 minutes while the tab is open

/* ---------------------------------- AUTH --------------------------------- */
function initAuth(onSignedIn){
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPE,
    callback: (resp) => {
      if(resp.error){ showAuthError(resp); return; }
      accessToken = resp.access_token;
      onSignedIn();
    },
  });
}
function signIn(){
  if(!tokenClient){ showAuthError({error:"not_ready", error_description:"Still loading Google's sign-in script — try again in a second."}); return; }
  tokenClient.requestAccessToken({prompt: accessToken ? '' : 'consent'});
}
function signOut(){
  if(accessToken){ google.accounts.oauth2.revoke(accessToken, () => {}); }
  accessToken = null;
  clearInterval(refreshTimer);
  location.reload();
}

/* --------------------------------- DRIVE ---------------------------------- */
const DRIVE = "https://www.googleapis.com/drive/v3";
async function driveFetch(url){
  const res = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
  if(!res.ok) throw new Error("Drive API " + res.status + " for " + url);
  return res;
}
async function listFolder(folderId){
  const url = `${DRIVE}/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc&pageSize=50`;
  const res = await driveFetch(url);
  return (await res.json()).files || [];
}
async function getMeta(fileId){
  const res = await driveFetch(`${DRIVE}/files/${fileId}?fields=id,name,mimeType,modifiedTime`);
  return res.json();
}
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
async function downloadWorkbook(fileId){
  const meta = await getMeta(fileId);
  let res;
  if(meta.mimeType === "application/vnd.google-apps.spreadsheet"){
    res = await driveFetch(`${DRIVE}/files/${fileId}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`);
  } else {
    res = await driveFetch(`${DRIVE}/files/${fileId}?alt=media`);
  }
  const buf = await res.arrayBuffer();
  return { meta, workbook: XLSX.read(buf, {type:"array", cellDates:true}) };
}

/* pick "current" order tracker: most recently modified file in the folder */
async function resolveOrderTrackerFile(){
  const files = await listFolder(CONFIG.ORDER_TRACKER_FOLDER_ID);
  const xlsx = files.filter(f => /BIM Order Tracker/i.test(f.name));
  if(!xlsx.length) throw new Error("No 'BIM Order Tracker' file found in the configured folder.");
  return xlsx[0]; // orderBy modifiedTime desc already
}
/* pick income statement matching current year, fallback to most recent */
async function resolveIncomeStatementFile(){
  const files = await listFolder(CONFIG.INCOME_STATEMENT_FOLDER_ID);
  const year = String(new Date().getFullYear());
  const named = files.find(f => f.name.includes(year));
  return named || files[0];
}

/* ------------------------------ SHEET HELPERS ----------------------------- */
function sheetRows(workbook, sheetName){
  const sheet = workbook.Sheets[sheetName];
  if(!sheet) return null;
  return XLSX.utils.sheet_to_json(sheet, {header:1, defval:"", raw:false});
}
function findSheetByHeaderText(workbook, mustContain){
  for(const name of workbook.SheetNames){
    const rows = sheetRows(workbook, name);
    if(!rows) continue;
    for(const row of rows){
      const joined = row.join(" | ").toLowerCase();
      if(mustContain.every(t => joined.includes(t.toLowerCase()))) return {name, rows};
    }
  }
  return null;
}
function cellText(v){ return (v===undefined||v===null) ? "" : String(v).trim(); }
function toNum(v){
  if(v===undefined||v===null||v==="") return 0;
  let s = String(v).trim();
  if(s==="") return 0;
  const negParen = /^\(.*\)$/.test(s);
  if(negParen) s = s.slice(1,-1);
  // pull out the first plain numeric run instead of trying to strip every
  // possible currency prefix (₱, PHP, P, etc.) — far more robust across
  // whatever formatting a given sheet actually uses.
  const m = s.match(/-?\d[\d,]*\.?\d*/);
  if(!m) return 0;
  const n = parseFloat(m[0].replace(/,/g,""));
  if(isNaN(n)) return 0;
  return negParen ? -n : n;
}
/* label above, value in the same column one row below (dashboard KPI style) */
function findValueBelow(rows, label){
  for(let r=0; r<rows.length; r++){
    for(let c=0; c<rows[r].length; c++){
      if(cellText(rows[r][c]).toLowerCase() === label.toLowerCase()){
        const below = rows[r+1];
        if(below) return below[c];
      }
    }
  }
  return undefined;
}
/* label, then next non-empty cell to the right on the same row */
function findValueRight(rows, label){
  for(let r=0; r<rows.length; r++){
    for(let c=0; c<rows[r].length; c++){
      if(cellText(rows[r][c]).toLowerCase() === label.toLowerCase()){
        for(let c2=c+1; c2<rows[r].length; c2++){
          if(cellText(rows[r][c2]) !== "") return rows[r][c2];
        }
      }
    }
  }
  return undefined;
}
function findKpi(rows, label){
  const v = findValueBelow(rows, label);
  if(v !== undefined && cellText(v) !== "") return v;
  return findValueRight(rows, label);
}
function findHeaderRow(rows, colNamesLower){
  for(let r=0; r<rows.length; r++){
    const lower = rows[r].map(c => cellText(c).toLowerCase());
    if(colNamesLower.every(n => lower.includes(n))) return {rowIdx:r, cols: colNamesLower.map(n => lower.indexOf(n))};
  }
  return null;
}

/* ============================== EXTRACTORS =============================== */

function extractSales(workbook){
  const dash = findSheetByHeaderText(workbook, ["total sales", "total cost", "net profit"]);
  if(!dash) throw new Error("Couldn't find the sales Dashboard sheet/KPI block.");
  const rows = dash.rows;

  const period = (() => {
    for(const row of rows){ for(const c of row){ const t = cellText(c); if(/[A-Za-z]+\s+\d+\s*[-–—]\s*[A-Za-z]*\s*\d+,\s*20\d\d/.test(t)) return t; } }
    return "";
  })();

  const kpi = {
    totalSales: toNum(findKpi(rows,"TOTAL SALES")),
    totalCost: toNum(findKpi(rows,"TOTAL COST")),
    netProfit: toNum(findKpi(rows,"NET PROFIT")),
    totalOrders: toNum(findKpi(rows,"TOTAL ORDERS")),
    unitsSold: toNum(findKpi(rows,"UNITS SOLD")),
    topChannel: cellText(findKpi(rows,"TOP CHANNEL")) || "—",
  };
  kpi.margin = kpi.totalSales ? +((kpi.netProfit/kpi.totalSales)*100).toFixed(1) : 0;
  kpi.topChannelSales = 0; // filled in below once channel table parsed

  const chanHeader = findHeaderRow(rows, ["channel","orders","qty","sales","cost","profit"]);
  const channels = [];
  if(chanHeader){
    const [nameCol, ordersCol, qtyCol, salesCol, costCol, profitCol] = chanHeader.cols;
    for(let r=chanHeader.rowIdx+1; r<rows.length; r++){
      const name = cellText(rows[r][nameCol]);
      if(!name || /^total$/i.test(name)) break;
      channels.push({
        name, orders: toNum(rows[r][ordersCol]), qty: toNum(rows[r][qtyCol]),
        sales: toNum(rows[r][salesCol]), cost: toNum(rows[r][costCol]), profit: toNum(rows[r][profitCol]),
      });
    }
  }
  const top = [...channels].sort((a,b)=>b.sales-a.sales)[0];
  if(top){ kpi.topChannel = kpi.topChannel==="—" ? top.name : kpi.topChannel; kpi.topChannelSales = top.sales; }
  const totals = channels.reduce((a,c)=>({orders:a.orders+c.orders, qty:a.qty+c.qty, sales:a.sales+c.sales, cost:a.cost+c.cost, profit:a.profit+c.profit}), {orders:0,qty:0,sales:0,cost:0,profit:0});

  // top 5 products: same row as the channel header, but "Product" col + the *next*
  // "Qty"/"Sales" columns after it — the channel table already used the first
  // occurrence of those two labels, so search strictly after the Product column.
  let topProducts = [];
  const prodHeaderRowIdx = rows.findIndex(row => row.some(c => cellText(c).toLowerCase()==="product"));
  const prodHeader = prodHeaderRowIdx>=0 ? (() => {
    const lower = rows[prodHeaderRowIdx].map(c=>cellText(c).toLowerCase());
    const nameCol = lower.indexOf("product");
    const qtyCol = lower.indexOf("qty", nameCol+1);
    const salesCol = lower.indexOf("sales", nameCol+1);
    return (qtyCol>=0 && salesCol>=0) ? {rowIdx:prodHeaderRowIdx, cols:[nameCol,qtyCol,salesCol]} : null;
  })() : null;
  if(prodHeader){
    const nameCol = prodHeader.cols[0], qtyCol = prodHeader.cols[1], salesCol = prodHeader.cols[2];
    for(let r=prodHeader.rowIdx+1; r<rows.length; r++){
      const name = cellText(rows[r][nameCol]);
      if(!name || /^total$/i.test(name)) break;
      topProducts.push({ name, qty: toNum(rows[r][qtyCol]), sales: toNum(rows[r][salesCol]) });
    }
  }
  topProducts = topProducts.filter(p=>p.sales>0).sort((a,b)=>b.sales-a.sales).slice(0,5);

  // daily trend: header row Date/Lazada/Shopee/Tiktok/Marketplace
  const dailyHeader = findHeaderRow(rows, ["date","lazada","shopee","marketplace"]);
  const daily = [];
  if(dailyHeader){
    const {rowIdx} = dailyHeader;
    const dateCol = rows[rowIdx].findIndex(c=>cellText(c).toLowerCase()==="date");
    for(let r=rowIdx+1; r<rows.length; r++){
      const label = cellText(rows[r][dateCol]);
      if(!label || /^total$/i.test(label)) break;
      const laz = toNum(rows[r][dateCol+1]), shp = toNum(rows[r][dateCol+2]), ttk = toNum(rows[r][dateCol+3]), mkt = toNum(rows[r][dateCol+4]);
      if(laz||shp||ttk||mkt) daily.push([label, laz, shp, ttk, mkt]);
    }
  }

  const stats = {
    avgDailySales: toNum(findKpi(rows,"AVG DAILY SALES")),
    avgDailyOrders: toNum(findKpi(rows,"AVG DAILY ORDERS")),
    bestChannel: cellText(findKpi(rows,"BEST CHANNEL")),
    bestDay: cellText(findKpi(rows,"BEST DAY")),
    avgOrderValue: toNum(findKpi(rows,"AVG ORDER VALUE")),
  };

  return { period, kpi, channels, totals, topProducts, daily, stats };
}

function extractFinancials(workbook){
  const dash = findSheetByHeaderText(workbook, ["total revenue", "total expenses", "net income"]);
  if(!dash) throw new Error("Couldn't find the Income Statement KPI block.");
  const rows = dash.rows;
  const kpi = {
    revenue: toNum(findKpi(rows,"TOTAL REVENUE (YTD)")),
    expenses: Math.abs(toNum(findKpi(rows,"TOTAL EXPENSES (YTD)"))),
    netIncome: toNum(findKpi(rows,"NET INCOME (YTD)")),
    avgNetIncomeMo: toNum(findKpi(rows,"AVG NET INCOME / MO.")),
    totalCollections: toNum(findKpi(rows,"TOTAL COLLECTIONS")),
  };
  kpi.margin = kpi.revenue ? +((kpi.netIncome/kpi.revenue)*100).toFixed(1) : 0;

  const monthHeader = findHeaderRow(rows, ["php","jan","feb","dec"]);
  const monthly = [];
  if(monthHeader){
    const hdrRow = rows[monthHeader.rowIdx];
    const monthCols = [];
    hdrRow.forEach((c,i)=>{ if(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i.test(cellText(c))) monthCols.push({i, m: cellText(c)}); });
    // search every column for the row label, not a hardcoded index — the
    // label's exact column position can shift depending on the sheet.
    const findRow = (label) => { for(let r=monthHeader.rowIdx+1;r<rows.length;r++){ if(rows[r].some(c => cellText(c).toLowerCase()===label.toLowerCase())) return rows[r]; } return null; };
    const revRow = findRow("Revenue"), expRow = findRow("Expenses"), niRow = findRow("Net Income");
    monthCols.forEach(({i,m}) => {
      monthly.push({ m, rev: revRow?toNum(revRow[i]):0, exp: Math.abs(expRow?toNum(expRow[i]):0), ni: niRow?toNum(niRow[i]):0 });
    });
  }

  const collections = {
    cheque: toNum(findKpi(rows,"CHEQUE COLLECTED")),
    cash: toNum(findKpi(rows,"CASH COLLECTED")),
    total: kpi.totalCollections,
  };
  // NOTE: "Total Amount" labels appear once in the Cheque KPI block and again
  // in the Cash KPI block, so a plain label search would grab whichever comes
  // first. The top-of-sheet "CHEQUE/CASH COLLECTED" figures are unambiguous —
  // use those for the totals instead of re-deriving from the detail tables.
  const cheque = {
    total: collections.cheque,
    cleared: toNum(findValueRight(rows,"Cleared Amount")),
    pending: toNum(findValueRight(rows,"Pending Amount")),
    bounced: toNum(findValueRight(rows,"Bounced Amount")),
    totalCount: toNum(findValueRight(rows,"Total Cheques")),
    clearedCount: toNum(findValueRight(rows,"Cleared Count")),
    pendingCount: toNum(findValueRight(rows,"Pending Count")),
    bouncedCount: toNum(findValueRight(rows,"Bounced Count")),
    avgPendingAge: toNum(findValueRight(rows,"Avg Pending Age (days)")),
  };
  const cash = {
    total: collections.cash,
    count: toNum(findValueRight(rows,"Record Count")),
    avg: toNum(findValueRight(rows,"Average Amount")),
  };

  // top payers table: "Payer/Payee" appears twice (the full alphabetical list,
  // and the curated top-10 "Rank" list) — anchor on the unique "Rank" column
  // and take the Payer/Payee + Amount columns immediately after it.
  const rankRowIdx = rows.findIndex(row => row.some(c => cellText(c).toLowerCase()==="rank"));
  const payerHeader = (() => {
    if(rankRowIdx<0) return null;
    const lower = rows[rankRowIdx].map(c=>cellText(c).toLowerCase());
    const rankCol = lower.indexOf("rank");
    const nameCol = lower.indexOf("payer/payee", rankCol+1);
    const amtCol = lower.indexOf("amount", rankCol+1);
    return (nameCol>=0 && amtCol>=0) ? {rowIdx:rankRowIdx, cols:[nameCol,amtCol]} : null;
  })();
  let topPayers = [];
  if(payerHeader){
    const nameCol = payerHeader.cols[0], amtCol = payerHeader.cols[1];
    for(let r=payerHeader.rowIdx+1; r<rows.length; r++){
      const name = cellText(rows[r][nameCol]);
      if(!name) continue;
      if(/grand total/i.test(name)) break;
      const amt = toNum(rows[r][amtCol]);
      if(amt>0) topPayers.push({name, amount: amt});
    }
  }
  topPayers = topPayers.sort((a,b)=>b.amount-a.amount).slice(0,10);

  return { kpi, monthly, collections, cheque, cash, topPayers };
}

function extractInventory(workbook){
  // stock-qty / inventory-value column headers have been renamed at least
  // once already — match on any known wording rather than one fixed string.
  const STOCK_HEADERS = ["realtime stocks quantity","total stock qty","stock qty","stock quantity"];
  const VALUE_HEADERS = ["inventory value","total inventory value"];

  // Prefer a sheet whose NAME contains "business" + "inventory" (fuzzy, in
  // case of extra spacing/wording) — the workbook has other tabs (Dashboard,
  // etc.) whose headers can look similar, and a pure content search could
  // grab the wrong one.
  const namedSheet = workbook.SheetNames.find(n => {
    const t = n.trim().toLowerCase();
    return t.includes("business") && t.includes("inventory");
  });
  let table = null;
  if(namedSheet){
    table = { name: namedSheet, rows: sheetRows(workbook, namedSheet) };
  }
  if(!table){
    for(const n of workbook.SheetNames){
      const rows = sheetRows(workbook, n);
      if(!rows) continue;
      const hasProduct = rows.some(row => row.some(c => cellText(c).toLowerCase()==="product name"));
      const hasStock = rows.some(row => row.some(c => STOCK_HEADERS.includes(cellText(c).toLowerCase())));
      if(hasProduct && hasStock){ table = {name:n, rows}; break; }
    }
  }
  if(!table) throw new Error("Couldn't find the main inventory table. Sheets in this file: " + workbook.SheetNames.join(", "));
  window.__DEBUG_INV_SHEET = { usedNamedSheet: !!namedSheet, sheetName: table.name, allSheetNames: workbook.SheetNames };
  const rows = table.rows;
  const hdr = findHeaderRow(rows, ["product name","cost per item","sku"]);
  if(!hdr) throw new Error("Inventory header row didn't match expected columns.");
  const headerRowRaw = rows[hdr.rowIdx].map(c=>cellText(c).toLowerCase());
  const idx = (name) => headerRowRaw.indexOf(name);
  const idxAny = (names) => { for(const n of names){ const i = headerRowRaw.indexOf(n); if(i>=0) return i; } return -1; };
  const cVendor = 0, cName = idx("product name"), cPart = idx("particulars"), cExp = idx("expiry"),
        cCost = idx("cost per item"), cSku = idx("sku"), cStock = idxAny(STOCK_HEADERS), cVal = idxAny(VALUE_HEADERS),
        cLaz = idx("lazada"), cShp = idx("shopee"), cTtk = idx("tiktok"), cDir = idx("direct");
  if(cStock<0 || cVal<0) throw new Error("Couldn't find the Stock Qty / Inventory Value columns — header text: " + JSON.stringify(rows[hdr.rowIdx]));

  window.__DEBUG_INV = {
    headerRow: rows[hdr.rowIdx],
    sampleRawRows: rows.slice(hdr.rowIdx+1, hdr.rowIdx+4),
    colIndex: {cVendor,cName,cPart,cExp,cCost,cSku,cStock,cVal,cLaz,cShp,cTtk,cDir},
  };

  const items = [];
  for(let r=hdr.rowIdx+1; r<rows.length; r++){
    const name = cellText(rows[r][cName]);
    // skip blank rows and any grand-total / subtotal row so it doesn't get
    // counted as a giant phantom "item" and double the real sum.
    if(!name || /^(grand\s*)?total/i.test(name)) continue;
    const vendorText = cellText(rows[r][cVendor]);
    if(/^(grand\s*)?total/i.test(vendorText)) continue;
    items.push({
      v: cellText(rows[r][cVendor]), n: name, p: cellText(rows[r][cPart]), exp: cellText(rows[r][cExp]),
      cost: toNum(rows[r][cCost]), sku: toNum(rows[r][cSku]), stock: toNum(rows[r][cStock]), val: toNum(rows[r][cVal]),
      laz: toNum(rows[r][cLaz]), shp: toNum(rows[r][cShp]), ttk: toNum(rows[r][cTtk]), dir: toNum(rows[r][cDir]),
    });
  }

  // Compute every summary number directly from the Business Inventory
  // Template rows themselves, rather than trusting a separate Dashboard/
  // scorecard cell elsewhere in the workbook — that cell can be a stale
  // pivot/cached value that drifts from the real, live item table.
  const scorecard = {
    totalValue: items.reduce((s,i)=>s+i.val,0),
    totalStock: items.reduce((s,i)=>s+Math.max(i.stock,0),0),
    outOfStock: items.filter(i=>i.stock<=0).length,
  };
  const platform = {
    Lazada: items.reduce((s,i)=>s+i.laz,0),
    Shopee: items.reduce((s,i)=>s+i.shp,0),
    TikTok: items.reduce((s,i)=>s+i.ttk,0),
    Direct: items.reduce((s,i)=>s+i.dir,0),
  };

  return { items, scorecard, platform };
}

function extractPriceList(workbook){
  const out = [];
  for(const name of workbook.SheetNames){
    const rows = sheetRows(workbook, name);
    if(!rows) continue;
    const hdr = findHeaderRow(rows, ["product name","price"]);
    if(!hdr) continue;
    const headerRowRaw = rows[hdr.rowIdx].map(c=>cellText(c).toLowerCase());
    const cName = headerRowRaw.indexOf("product name");
    const cSize = headerRowRaw.findIndex(h=>h.includes("size")||h.includes("variant"));
    const cPrice = headerRowRaw.indexOf("price");
    const cNote = headerRowRaw.indexOf("notes");
    const catLabel = cellText(rows[hdr.rowIdx][0]).replace(/category.*/i,"").trim() || name;
    for(let r=hdr.rowIdx+1; r<rows.length; r++){
      const rowVals = rows[r].map(cellText);
      const pname = cellText(rows[r][cName]);
      if(!pname || /^out of stock$/i.test(pname)) continue;
      const os = rowVals.some(v=>v.toUpperCase()==="OS");
      const priceRaw = cPrice>=0 ? rows[r][cPrice] : "";
      out.push({
        cat: catLabel, n: pname,
        sz: cSize>=0 ? cellText(rows[r][cSize]) : "",
        price: cellText(priceRaw)==="" ? null : toNum(priceRaw),
        note: cNote>=0 ? cellText(rows[r][cNote]) : "",
        os,
      });
    }
  }
  return out;
}

/* ============================== ORCHESTRATION ============================== */
async function loadAll(){
  setStatus("loading");
  const errors = [];
  let salesWb, finWb, invWb, plWb;

  try{
    const otFile = await resolveOrderTrackerFile();
    salesWb = (await downloadWorkbook(otFile.id)).workbook;
  } catch(e){ errors.push("Order Tracker: " + e.message); }

  try{
    const isFile = await resolveIncomeStatementFile();
    finWb = (await downloadWorkbook(isFile.id)).workbook;
  } catch(e){ errors.push("Income Statement: " + e.message); }

  try{
    invWb = (await downloadWorkbook(CONFIG.INVENTORY_FILE_ID)).workbook;
  } catch(e){ errors.push("Inventory: " + e.message); }

  try{
    plWb = (await downloadWorkbook(CONFIG.PRICELIST_FILE_ID)).workbook;
  } catch(e){ errors.push("Price List: " + e.message); }

  try{ if(salesWb) window.SALES_LIVE = extractSales(salesWb); } catch(e){ errors.push("Order Tracker parse: " + e.message); }
  try{ if(finWb) window.FIN_LIVE = extractFinancials(finWb); } catch(e){ errors.push("Income Statement parse: " + e.message); }
  try{ if(invWb) window.INV_LIVE = extractInventory(invWb); } catch(e){ errors.push("Inventory parse: " + e.message); }
  try{ if(plWb) window.PL_LIVE = extractPriceList(plWb); } catch(e){ errors.push("Price List parse: " + e.message); }

  renderAll();
  setStatus(errors.length ? "warn" : "live", errors);
}

function startAutoRefresh(){
  clearInterval(refreshTimer);
  refreshTimer = setInterval(loadAll, REFRESH_MS);
}
