// ── Bake It More Dashboard — configuration ───────────────────────────────
// Fill in CLIENT_ID once you have it from Google Cloud Console (Step 2 in
// the setup instructions). Everything else here already points at your
// actual Drive files/folders and normally shouldn't need to change.

const CONFIG = {
  // OAuth 2.0 Web application Client ID from console.cloud.google.com
  // (Credentials → OAuth client ID). Looks like "123...apps.googleusercontent.com"
  CLIENT_ID: "207363292659-n0iu7quhvb3do28dmfsve78som3ld4mf.apps.googleusercontent.com",

  // Read-only scope — the app never writes to your Drive.
  SCOPE: "https://www.googleapis.com/auth/drive.readonly",

  // Folder that contains the monthly "<Mon> <Year> BIM Order Tracker.xlsx" files.
  // The app picks the most-recently-modified file in this folder as "current month".
  ORDER_TRACKER_FOLDER_ID: "1IUoojW5_OKnf_oNaEeOHkiLlGIfOaqcz",

  // Folder that contains the yearly "BakeItMore IS <Year>.xlsx" income statements.
  // The app picks the file whose title contains the current year, falling back
  // to the most-recently-modified file in the folder if no exact match.
  INCOME_STATEMENT_FOLDER_ID: "1oHl1Iphy8yUko5BHk2NBoCl1GQwU4pVT",

  // Fixed files (these don't rotate monthly/yearly).
  INVENTORY_FILE_ID: "1aomSz_xj1UHwEgbFj_HwJcyy6EbVmjyzfSSsjyxmGJ8",
  PRICELIST_FILE_ID: "1BBgxtUYzO6l-q41GCQW7zTpzlgufEYEu",

  // NOTE: the Platform Report tab no longer needs its own file — it reads
  // the Shopee/Lazada/TikTok breakdown straight out of the same Income
  // Statement workbook resolved above (INCOME_STATEMENT_FOLDER_ID), since
  // that file already has an "Income Statement — <Month> <Year>" block per
  // month. The old dedicated sheet (below) is no longer used by the app —
  // keeping the ID here only for reference.
  PLATFORM_INCOME_FILE_ID_UNUSED: "1vvkpK4hykchRD3Dr66FUil22r4Lk_ad2pLNQOP7fjrY",
};
