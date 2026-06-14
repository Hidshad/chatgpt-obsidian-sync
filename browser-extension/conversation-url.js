(function installConversationUrlParser(root) {
  function parseConversationIdFromUrl(pageUrl) {
    let url;
    try {
      url = new URL(String(pageUrl || ""));
    } catch (_error) {
      return null;
    }

    if (!["chatgpt.com", "chat.openai.com"].includes(url.hostname)) {
      return null;
    }

    const match = url.pathname.match(/^\/c\/([^/?#/]+)/);
    if (!match || !match[1]) {
      return null;
    }

    try {
      return decodeURIComponent(match[1]);
    } catch (_error) {
      return match[1];
    }
  }

  const api = { parseConversationIdFromUrl };
  root.ChatGptObsidianUrl = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
