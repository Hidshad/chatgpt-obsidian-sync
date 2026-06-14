// ==UserScript==
// @name         ChatGPT Obsidian Sync
// @namespace    local.chatgpt-obsidian-sync
// @version      0.5.0
// @description  Legacy developer fallback only; not recommended for production sync.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      127.0.0.1:8765
// @connect      localhost
// @connect      localhost:8765
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // Legacy only, not recommended for production sync.
  // The ordinary user path is browser-extension + local sync server.
  console.log("[ChatGPT Obsidian Sync] userscript loaded");

  const SERVER_URL = "http://127.0.0.1:8765/api/messages";
  const ASSET_URL = "http://127.0.0.1:8765/api/assets";
  const IMPORT_URL = "http://127.0.0.1:8765/api/conversation/import";
  const SCAN_INTERVAL_MS = 3000;
  const SEND_DEBOUNCE_MS = 800;
  const DEBUG_ASSETS = false;

  let sendTimer = null;
  let lastPayloadJson = "";
  let syncInProgress = false;
  const assetUploadCache = new Map();
  let currentAssetStats = null;
  const fullImportedConversationIds = new Set();

  function hashText(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function conversationIdFromUrl() {
    return getConversationId({ allowFallback: true, log: false });
  }

  function getConversationId(options = {}) {
    const { allowFallback = false, log = true } = options;
    if (log) {
      console.log("[ChatGPT Obsidian Sync] current href:", location.href);
    }

    const pathParts = location.pathname.split("/").filter(Boolean);
    const cIndex = pathParts.indexOf("c");
    let conversationId = "";
    if (cIndex >= 0 && pathParts[cIndex + 1]) {
      conversationId = decodeURIComponent(pathParts[cIndex + 1]);
    }

    if (conversationId) {
      if (log) {
        console.log("[ChatGPT Obsidian Sync] conversation id:", conversationId);
      }
      return conversationId;
    }

    if (log) {
      console.log("[ChatGPT Obsidian Sync] conversation id:", conversationId);
    }

    if (allowFallback) {
      return `page-${hashText(window.location.href)}`;
    }

    const message =
      "当前页面不是普通 ChatGPT 会话页，无法完整导入。请打开 https://chatgpt.com/c/<conversation_id> 页面。";
    alert(`${message}\n\n${location.href}`);
    throw new Error(message);
  }

  function titleFromPage() {
    const title = document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, "").trim();
    return title || "Untitled Chat";
  }

  function messageIdFor(node, role, position, content) {
    const explicitId =
      node.getAttribute("data-message-id") ||
      node.closest("[data-message-id]")?.getAttribute("data-message-id");
    if (explicitId) {
      return explicitId;
    }
    return `dom-${position}-${role}-${hashText(content.slice(0, 120))}`;
  }

  function postJson(url, payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url,
        headers: {
          "Content-Type": "application/json",
        },
        data: JSON.stringify(payload),
        onload(response) {
          let data = {};
          try {
            data = JSON.parse(response.responseText || "{}");
          } catch (_error) {
            data = {};
          }
          if (response.status >= 200 && response.status < 300 && data.ok !== false) {
            resolve(data);
          } else {
            reject(new Error(data.error || `Local request failed: ${response.status}`));
          }
        },
        onerror(error) {
          reject(error);
        },
      });
    });
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function extensionFromMimeType(mimeType) {
    const normalized = (mimeType || "").split(";")[0].toLowerCase();
    if (normalized === "image/png") return ".png";
    if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
    if (normalized === "image/webp") return ".webp";
    if (normalized === "image/gif") return ".gif";
    return "";
  }

  function extensionFromUrl(url) {
    try {
      const pathname = new URL(url, location.href).pathname.toLowerCase();
      const match = pathname.match(/\.(png|jpg|jpeg|webp|gif)$/);
      if (!match) return "";
      return match[1] === "jpeg" ? ".jpg" : `.${match[1]}`;
    } catch (_error) {
      return "";
    }
  }

  function lowerAttribute(value) {
    return String(value || "").toLowerCase();
  }

  function imageLooksLikeIconByText(imgElement) {
    const text = [
      imgElement.getAttribute("alt"),
      imgElement.getAttribute("aria-label"),
      imgElement.className,
    ]
      .map(lowerAttribute)
      .join(" ");
    return (
      text.includes("favicon") ||
      text.includes("icon") ||
      text.includes("avatar") ||
      text.includes("logo")
    );
  }

  function imageIsInsideIgnoredChrome(imgElement) {
    return Boolean(
      imgElement.closest(
        'button, nav, header, footer, [role="button"], [aria-label*="avatar" i], [aria-label*="logo" i], [data-testid*="avatar" i], [data-testid*="copy" i], [data-testid*="share" i]'
      )
    );
  }

  function shouldCollectImage(imgElement, messageNode) {
    const src = imgElement.currentSrc || imgElement.src || "";
    const lowerSrc = src.toLowerCase();
    const naturalWidth = Number(imgElement.naturalWidth || 0);
    const naturalHeight = Number(imgElement.naturalHeight || 0);
    const isDataOrBlob = lowerSrc.startsWith("data:") || lowerSrc.startsWith("blob:");

    if (!src || !messageNode.contains(imgElement)) {
      return false;
    }
    if (
      lowerSrc.includes("google.com/s2/favicons") ||
      lowerSrc.includes("favicon") ||
      lowerSrc.includes("/favicon")
    ) {
      return false;
    }
    if (lowerSrc.startsWith("data:image/svg+xml") || lowerSrc.endsWith(".svg")) {
      return false;
    }
    if (imageLooksLikeIconByText(imgElement) || imageIsInsideIgnoredChrome(imgElement)) {
      return false;
    }
    if (!isDataOrBlob && naturalWidth > 0 && naturalHeight > 0) {
      if (naturalWidth < 128 || naturalHeight < 128) {
        return false;
      }
      if (imgElement.closest("a") && (naturalWidth < 160 || naturalHeight < 160)) {
        return false;
      }
    }
    return true;
  }

  async function collectImageAsset(imgElement, context) {
    const src = imgElement.currentSrc || imgElement.src;
    if (!src) {
      return { status: "failed", error: "missing image src" };
    }

    try {
      const cacheKey = `${context.conversationId}|${context.messageId}|${src}`;
      if (assetUploadCache.has(cacheKey)) {
        if (currentAssetStats) {
          currentAssetStats.uploaded += 1;
        }
        return assetUploadCache.get(cacheKey);
      }

      let mimeType = "";
      let base64Data = "";
      let suggestedExt = "";

      if (src.startsWith("data:image/")) {
        const match = src.match(/^data:([^;,]+);base64,(.*)$/);
        if (!match) {
          throw new Error("Unsupported data image URL");
        }
        mimeType = match[1];
        base64Data = match[2];
        suggestedExt = extensionFromMimeType(mimeType);
      } else if (src.startsWith("blob:") || src.startsWith("https:")) {
        const response = await fetch(src, { credentials: "include" });
        if (!response.ok) {
          throw new Error(`Image fetch failed: ${response.status}`);
        }
        const blob = await response.blob();
        mimeType = blob.type || "application/octet-stream";
        base64Data = arrayBufferToBase64(await blob.arrayBuffer());
        suggestedExt = extensionFromMimeType(mimeType) || extensionFromUrl(src);
      } else {
        throw new Error("Unsupported image URL scheme");
      }

      const result = await postJson(ASSET_URL, {
        conversation_id: context.conversationId,
        title: context.title,
        message_id: context.messageId,
        source_url: src.slice(0, 500),
        mime_type: mimeType,
        base64_data: base64Data,
        suggested_ext: suggestedExt,
      });
      const assetResult = {
        status: "ok",
        kind: "image",
        local_relative_path: result.local_relative_path,
      };
      assetUploadCache.set(cacheKey, assetResult);
      if (currentAssetStats) {
        currentAssetStats.uploaded += 1;
      }
      return assetResult;
    } catch (error) {
      if (currentAssetStats) {
        currentAssetStats.failed += 1;
      }
      if (DEBUG_ASSETS) {
        console.warn("[chatgpt-obsidian-sync] image asset sync failed", {
          srcPreview: src.slice(0, 120),
          error: String(error && error.message ? error.message : error),
        });
      }
      return { status: "failed", error: String(error && error.message ? error.message : error) };
    }
  }

  async function collectImagesForMessage(node, context) {
    const images = Array.from(node.querySelectorAll("img[src]"));
    const assets = [];
    const seen = new Set();
    for (const img of images) {
      const src = img.currentSrc || img.src;
      if (!shouldCollectImage(img, node)) {
        if (currentAssetStats) {
          currentAssetStats.skipped += 1;
        }
        if (DEBUG_ASSETS) {
          console.debug("[chatgpt-obsidian-sync] skipped image asset", {
            srcPreview: String(src || "").slice(0, 120),
          });
        }
        continue;
      }
      if (!src || seen.has(src)) {
        continue;
      }
      seen.add(src);
      const asset = await collectImageAsset(img, context);
      if (asset.status === "ok") {
        assets.push({
          kind: "image",
          local_relative_path: asset.local_relative_path,
        });
      }
    }
    return assets;
  }

  async function collectMessages() {
    const nodes = Array.from(document.querySelectorAll("[data-message-author-role]"));
    const conversationId = conversationIdFromUrl();
    const title = titleFromPage();
    const messages = [];
    for (const [position, node] of nodes.entries()) {
        const role = (node.getAttribute("data-message-author-role") || "").toLowerCase();
        const content = (node.innerText || node.textContent || "").trim();
        if (!role) {
          continue;
        }
        const messageId = messageIdFor(node, role, position, content);
        const assets = await collectImagesForMessage(node, {
          conversationId,
          title,
          messageId,
        });
        if (!content && assets.length === 0) {
          continue;
        }
        messages.push({
          id: messageId,
          role,
          content,
          position,
          assets,
        });
    }
    return messages;
  }

  async function buildPayload() {
    return {
      conversation_id: conversationIdFromUrl(),
      title: titleFromPage(),
      messages: await collectMessages(),
    };
  }

  function sendPayload(payload) {
    GM_xmlhttpRequest({
      method: "POST",
      url: SERVER_URL,
      headers: {
        "Content-Type": "application/json",
      },
      data: JSON.stringify(payload),
      onload(response) {
        if (response.status >= 200 && response.status < 300) {
          console.debug("[chatgpt-obsidian-sync] synced", response.responseText);
        } else {
          console.warn("[chatgpt-obsidian-sync] sync failed", response.status, response.responseText);
        }
      },
      onerror(error) {
        console.warn("[chatgpt-obsidian-sync] local service unreachable", error);
      },
    });
  }

  function postImportPayload(payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: IMPORT_URL,
        headers: {
          "Content-Type": "application/json",
        },
        data: JSON.stringify(payload),
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            resolve(JSON.parse(response.responseText || "{}"));
          } else {
            reject(new Error(`Local import failed: ${response.status} ${response.responseText}`));
          }
        },
        onerror(error) {
          reject(error);
        },
      });
    });
  }

  async function exportFullChatGPTConversationToObsidian() {
    const conversationId = getConversationId();
    const url = `/backend-api/conversation/${conversationId}`;
    let fetchResult = await fetchConversationJsonWithPageFetch(conversationId);

    if (
      fetchResult.status === 404 &&
      fetchResult.responseText.includes("conversation_inaccessible")
    ) {
      console.warn(
        "[ChatGPT Obsidian Sync] unsafeWindow.fetch returned conversation_inaccessible; falling back to injected page fetch"
      );
      try {
        fetchResult = await fetchConversationJsonInPageContext(conversationId);
      } catch (error) {
        fetchResult = {
          ok: false,
          status: 0,
          responseText: String(error && error.stack || error),
          href: location.href,
          conversationId,
          url,
          fetchMethod: "injected page fetch",
        };
      }
    }

    if (!fetchResult.ok) {
      logConversationFetchFailure(fetchResult);
      throw new Error(`ChatGPT conversation fetch failed: ${fetchResult.status}`);
    }

    let conversation;
    try {
      conversation = JSON.parse(fetchResult.responseText);
    } catch (error) {
      console.error("[ChatGPT Obsidian Sync] conversation JSON parse failed", {
        href: location.href,
        conversationId,
        url,
        fetchMethod: fetchResult.fetchMethod,
        responseText: fetchResult.responseText.slice(0, 500),
        error,
      });
      throw error;
    }

    const result = await postImportPayload(conversation);
    fullImportedConversationIds.add(conversationId);
    console.info("[chatgpt-obsidian-sync] full import complete", result);
    return result;
  }

  async function fetchConversationJsonWithPageFetch(conversationId) {
    const pageWindow =
      typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const pageFetch =
      pageWindow.fetch ? pageWindow.fetch.bind(pageWindow) : fetch.bind(window);
    const url = `/backend-api/conversation/${conversationId}`;

    console.log("[ChatGPT Obsidian Sync] fetch url:", url);
    console.log("[ChatGPT Obsidian Sync] using page fetch:", pageFetch !== fetch);

    const response = await pageFetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    });

    return {
      ok: response.ok,
      status: response.status,
      responseText: await response.text(),
      href: location.href,
      conversationId,
      url,
      fetchMethod: "unsafeWindow.fetch",
    };
  }

  function fetchConversationJsonInPageContext(conversationId) {
    const requestId = `chatgpt-obsidian-fetch-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const url = `/backend-api/conversation/${conversationId}`;
    let scriptLoaded = false;
    let startedReceived = false;
    let resultReceived = false;

    console.log("[ChatGPT Obsidian Sync] using injected page fetch via blob script");
    console.log("[ChatGPT Obsidian Sync] injected requestId =", requestId);

    return new Promise((resolve, reject) => {
      let cleanedUp = false;

      function cleanupScript(script, blobUrl) {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        script.remove();
        URL.revokeObjectURL(blobUrl);
      }

      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", handleMessage);
        reject(
          new Error(
            `Injected page fetch timed out. scriptLoaded=${scriptLoaded}, startedReceived=${startedReceived}, resultReceived=${resultReceived}`
          )
        );
      }, 15000);

      function handleMessage(event) {
        const data = event.data;
        if (!data || data.source !== "chatgpt-obsidian-sync") {
          return;
        }
        if (data.requestId !== requestId) {
          return;
        }

        if (data.type === "conversation-fetch-started") {
          startedReceived = true;
          console.log("[ChatGPT Obsidian Sync] injected page fetch started", data);
          return;
        }

        if (data.type !== "conversation-fetch-result") {
          return;
        }

        resultReceived = true;
        console.log("[ChatGPT Obsidian Sync] injected page fetch result received", {
          ok: data.ok,
          status: data.status,
          responsePreview: String(data.responseText || "").slice(0, 200),
        });
        window.clearTimeout(timeout);
        window.removeEventListener("message", handleMessage);
        resolve({
          ok: Boolean(data.ok),
          status: Number(data.status || 0),
          responseText: String(data.responseText || ""),
          href: location.href,
          conversationId,
          url,
          fetchMethod: "injected page fetch",
        });
      }

      window.addEventListener("message", handleMessage);

      const injectedCode = `
        (() => {
          const requestId = ${JSON.stringify(requestId)};
          const url = ${JSON.stringify(url)};
          window.postMessage({
            source: "chatgpt-obsidian-sync",
            type: "conversation-fetch-started",
            requestId
          }, "*");

          (async () => {
            try {
              const res = await window.fetch(url, {
                method: "GET",
                credentials: "include",
                headers: { "Accept": "application/json" }
              });
              const responseText = await res.text();
              window.postMessage({
                source: "chatgpt-obsidian-sync",
                type: "conversation-fetch-result",
                requestId,
                ok: res.ok,
                status: res.status,
                responseText
              }, "*");
            } catch (error) {
              window.postMessage({
                source: "chatgpt-obsidian-sync",
                type: "conversation-fetch-result",
                requestId,
                ok: false,
                status: 0,
                responseText: String(error && error.stack || error)
              }, "*");
            }
          })();
        })();
      `;
      const blob = new Blob([injectedCode], { type: "text/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      const script = document.createElement("script");
      script.src = blobUrl;

      const nonce = document.querySelector("script[nonce]")?.nonce;
      if (nonce) {
        script.nonce = nonce;
      }

      script.onload = () => {
        scriptLoaded = true;
        console.log("[ChatGPT Obsidian Sync] injected blob script loaded");
        cleanupScript(script, blobUrl);
      };
      script.onerror = (error) => {
        window.clearTimeout(timeout);
        window.removeEventListener("message", handleMessage);
        cleanupScript(script, blobUrl);
        console.error("[ChatGPT Obsidian Sync] injected blob script failed to load", error);
        reject(new Error("Injected blob script failed to load"));
      };

      console.log("[ChatGPT Obsidian Sync] appending injected blob script");
      (document.head || document.documentElement).appendChild(script);
    });
  }
  function logConversationFetchFailure(fetchResult) {
    console.error("[ChatGPT Obsidian Sync] conversation fetch failed", {
      href: fetchResult.href,
      conversationId: fetchResult.conversationId,
      url: fetchResult.url,
      status: fetchResult.status,
      responseText: fetchResult.responseText.slice(0, 500),
      fetchMethod: fetchResult.fetchMethod,
    });
  }

  function exposeFullExportFunction() {
    const exposedWindow =
      typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    exposedWindow.exportFullChatGPTConversationToObsidian =
      exportFullChatGPTConversationToObsidian;

    window.exportFullChatGPTConversationToObsidian =
      exportFullChatGPTConversationToObsidian;

    console.log("[ChatGPT Obsidian Sync] exportFullChatGPTConversationToObsidian exposed");
  }

  exposeFullExportFunction();

  setTimeout(() => {
    const exposedWindow =
      typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    exposedWindow.exportFullChatGPTConversationToObsidian =
      exportFullChatGPTConversationToObsidian;

    window.exportFullChatGPTConversationToObsidian =
      exportFullChatGPTConversationToObsidian;

    console.log("[ChatGPT Obsidian Sync] full export function exposed after delay");
  }, 1000);

  GM_registerMenuCommand(
    "Export full ChatGPT conversation to Obsidian",
    exportFullChatGPTConversationToObsidian
  );

  function scheduleSync() {
    window.clearTimeout(sendTimer);
    sendTimer = window.setTimeout(async () => {
      if (syncInProgress) {
        return;
      }
      syncInProgress = true;
      try {
        currentAssetStats = { uploaded: 0, skipped: 0, failed: 0 };
        const conversationId = conversationIdFromUrl();
        if (fullImportedConversationIds.has(conversationId)) {
          return;
        }
        const payload = await buildPayload();
        if (payload.messages.length === 0) {
          return;
        }
        const payloadJson = JSON.stringify(payload);
        if (payloadJson === lastPayloadJson) {
          return;
        }
        lastPayloadJson = payloadJson;
        sendPayload(payload);
        if (
          currentAssetStats.uploaded > 0 ||
          currentAssetStats.skipped > 0 ||
          currentAssetStats.failed > 0
        ) {
          console.info(
            `[ChatGPT Obsidian Sync] assets processed: ${currentAssetStats.uploaded} uploaded, ${currentAssetStats.skipped} skipped, ${currentAssetStats.failed} failed`
          );
        }
      } finally {
        currentAssetStats = null;
        syncInProgress = false;
      }
    }, SEND_DEBOUNCE_MS);
  }

  const observer = new MutationObserver(scheduleSync);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  window.setInterval(scheduleSync, SCAN_INTERVAL_MS);
  scheduleSync();
})();
