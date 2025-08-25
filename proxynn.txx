const express = require("express");
const axios = require("axios");
const registerBrowserFetch = require("./bfetch");

const app = express();

// Read your API key from env
const API_KEY = process.env.API_KEY || null;

// Middleware to check API key on protected routes
function apiKeyMiddleware(req, res, next) {
  if (!API_KEY) {
    console.warn("⚠️ API_KEY is not set in environment. Proxy is open to public!");
    return next(); // Optional: let it through if no key set
  }
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized: missing or invalid API key" });
  }
  next();
}

registerBrowserFetch(app, apiKeyMiddleware);

/**
 * Helpers
 */
function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function tryDecodeCookie(cookie) {
  if (!cookie) return cookie;
  try {
    const decoded = decodeURIComponent(cookie);
    if (decoded.includes("=") || decoded.includes(";")) return decoded;
  } catch (e) {
    // ignore
  }
  return cookie;
}

function buildForwardHeaders(req, queryHeaders, cookieFromQuery, refererFromQuery) {
  const headers = { ...req.headers };

  // Remove Host so target sees its own host
  delete headers.host;

  // Add Range if present on original request (seek support)
  if (req.headers.range) headers["range"] = req.headers.range;

  // Override/add referer if provided in query
  if (refererFromQuery) headers["referer"] = refererFromQuery;

  // Add cookie from query (decoded)
  if (cookieFromQuery) headers["cookie"] = cookieFromQuery;

  // Merge custom headers passed via query param (JSON)
  if (queryHeaders && typeof queryHeaders === "object") {
    Object.assign(headers, queryHeaders);
  }

  return headers;
}

/**
 * Root endpoint
 */
app.get("/", (req, res) => {
  res.send("Hello World");
});

/**
 * Streaming / universal proxy endpoint
 *
 * Usage:
 *  /fetch?url=<target>&cookie=<uri-encoded?>&headers=<json-string>&referer=<url>
 *
 * Accepts any HTTP method. Streams large bodies (uploads/downloads) without buffering.
 */
// Protect fetch route with API key middleware
app.all("/fetch", apiKeyMiddleware, async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing 'url' parameter");

  // decode cookie if present
  let cookie = req.query.cookie ? tryDecodeCookie(req.query.cookie) : null;

  // parse custom headers from query if provided (JSON string)
  const customHeaders = req.query.headers ? safeJsonParse(req.query.headers) : null;
  const referer = req.query.referer || null;

  // Build forwarded headers (remove host)
  const headers = buildForwardHeaders(req, customHeaders, cookie, referer);

  try {
    // Configure axios
    const axiosOptions = {
      url: targetUrl,
      method: req.method,
      headers,
      responseType: "stream",
      validateStatus: () => true, // forward all status codes
      maxRedirects: 5
    };

    // Handle request body if applicable
    const methodsWithBody = ["POST", "PUT", "PATCH", "DELETE"];
    if (methodsWithBody.includes(req.method.toUpperCase())) {
      axiosOptions.data = req;
    }

    // Perform the request
    const proxiedRes = await axios(axiosOptions);

    // Forward status & headers
    res.status(proxiedRes.status);
    for (const [key, value] of Object.entries(proxiedRes.headers)) {
      res.setHeader(key, value);
    }

    // Pipe response stream to client
    proxiedRes.data.pipe(res);

    // Handle proxy errors
    proxiedRes.data.on("error", (err) => {
      console.error("Proxy stream error:", err);
      if (!res.headersSent) res.status(502).send("Error streaming target");
      else res.end();
    });

  } catch (err) {
    console.error("Proxy error:", err.message || err);
    if (!res.headersSent) res.status(502).send("Error fetching target");
    else res.end();
  }
});

/**
 * Keep old /video route alias for compatibility (protected by API key as well)
 */
app.all("/video", apiKeyMiddleware, (req, res) => {
  const url = `/fetch${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
  req.url = url;
  app.handle(req, res);
});

/**
 * Add JSON and urlencoded parsers after streaming route for other routes if needed
 */
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`🚀 Universal streaming proxy running at http://localhost:${PORT}`);
  if (API_KEY) console.log("🔐 API Key protection enabled");
  else console.log("⚠️ Warning: API Key NOT set. Proxy is open to public!");
});
