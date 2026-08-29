// Single source of truth for the theme key: the pre-paint script and the
// toggle must agree, or a stored choice silently stops applying.
export const THEME_STORAGE_KEY = "promptbranch:theme";

// Pre-paint theme bootstrap: applies the stored (or system) theme before
// first paint so a light preference never flashes dark. Returned as a string
// because layout.tsx inlines it verbatim into a <script> under the CSP nonce.
export function themeInitScript(): string {
  return `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}document.documentElement.dataset.theme=t;}catch(e){}})();`;
}
