import "../app/prompt-window.css";
import "./widget.css";
import { initializeEmbeds } from "./widget-runtime.js";

const script = document.currentScript as HTMLScriptElement | null;
if (script?.src) {
  const scriptUrl = new URL(script.src, document.baseURI);
  initializeEmbeds({
    document,
    portalOrigin: scriptUrl.origin,
    assetBaseUrl: scriptUrl.origin,
    fetch: window.fetch.bind(window),
  });
}
