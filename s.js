const express = require("express");
const request = require("request");

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

const tough = require("tough-cookie"); // npm install tough-cookie
const jar = request.jar();

/**
 * Authenticated fetch endpoint that auto-handles cookie challenges
 *
 * Usage:
 *   /fetch-auth?url=<target>
 */
app.all("/fetch-auth", apiKeyMiddleware, (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing 'url' parameter");

  const options = {
    url: targetUrl,
    method: req.method,
    headers: { ...req.headers },
    jar,                 // 🔑 keeps cookies between redirects/requests
    encoding: null,
    followAllRedirects: true,
    gzip: true
  };

  // First request
  request(options, (err, firstRes, body) => {
    if (err) {
      console.error("First request error:", err);
      return res.status(502).send("Error fetching target");
    }

    // If the first response is HTML with reload loop ↄ1�7 retry with cookies
    const contentType = firstRes.headers["content-type"] || "";
    if (contentType.includes("text/html") && body.toString().includes("reload")) {
      console.log("⚠️ Got reload challenge, retrying with cookies...");

      // Second request with cookies
      request(options)
        .on("response", proxiedRes => {
          Object.keys(proxiedRes.headers).forEach((k) => {
            res.setHeader(k, proxiedRes.headers[k]);
          });
          res.status(proxiedRes.statusCode);
        })
        .on("error", err => {
          console.error("Proxy error:", err);
          if (!res.headersSent) res.status(502).send("Error fetching target");
          else res.end();
        })
        .pipe(res);

    } else {
      // First response is already correct ↄ1�7 stream it
      res.writeHead(firstRes.statusCode, firstRes.headers);
      res.end(body);
    }
  });
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
app.all("/fetch", apiKeyMiddleware, (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing 'url' parameter");

  // decode cookie if present
  let cookie = req.query.cookie ? tryDecodeCookie(req.query.cookie) : null;

  // parse custom headers from query if provided (JSON string)
  const customHeaders = req.query.headers ? safeJsonParse(req.query.headers) : null;
  const referer = req.query.referer || null;

  // Build forwarded headers (remove host)
  const headers = buildForwardHeaders(req, customHeaders, cookie, referer);

  const options = {
    url: targetUrl,
    method: req.method,
    headers,
    encoding: null,            // binary safe
    followAllRedirects: true,  // follow redirects
    gzip: true                 // accept gzip (transparent)
  };

  function attachResponseForward(proxied) {
    proxied.on("response", (proxiedRes) => {
      Object.keys(proxiedRes.headers).forEach((k) => {
        res.setHeader(k, proxiedRes.headers[k]);
      });
      res.status(proxiedRes.statusCode);
    });

    proxied.on("error", (err) => {
      console.error("Proxy error:", err);
      if (!res.headersSent) res.status(502).send("Error fetching target");
      else res.end();
    });

    proxied.pipe(res);
  }

  const contentType = (req.headers["content-type"] || "").split(";")[0];
  const methodsWithBody = ["POST", "PUT", "PATCH", "DELETE"];
  if (methodsWithBody.includes(req.method.toUpperCase()) && (contentType === "application/json" || contentType === "application/x-www-form-urlencoded")) {
    const MAX_BUFFER_FOR_PARSING = 5 * 1024 * 1024; // 5MB
    let collected = Buffer.alloc(0);
    let size = 0;
    let aborted = false;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BUFFER_FOR_PARSING) {
        aborted = true;
        const proxied = request(options);
        proxied.write(collected);
        req.pipe(proxied);
        attachResponseForward(proxied);
        req.removeAllListeners("data");
        req.removeAllListeners("end");
      } else {
        collected = Buffer.concat([collected, chunk]);
      }
    });

    req.on("end", () => {
      if (aborted) return;
      options.body = collected;
      if (contentType === "application/json") {
        try {
          options.json = JSON.parse(collected.toString("utf8"));
          delete options.body;
        } catch {
          options.body = collected;
        }
      }
      const proxied = request(options);
      attachResponseForward(proxied);
    });

    req.on("error", (err) => {
      console.error("Request read error:", err);
      res.status(400).send("Error reading request body");
    });

  } else {
    const proxied = request(options);
    attachResponseForward(proxied);
    req.pipe(proxied);
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

app.listen(8000, () => {
  console.log("🚀 Universal streaming proxy running at http://localhost:8000");
  if (API_KEY) console.log("🔐 API Key protection enabled");
  else console.log("⚠️ Warning: API Key NOT set. Proxy is open to public!");
});
