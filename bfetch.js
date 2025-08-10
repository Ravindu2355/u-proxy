const puppeteer = require("puppeteer");

// ...

// New browser-fetch endpoint for browser-like requests
app.get("/browser-fetch", apiKeyMiddleware, async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing 'url' parameter");

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();

    // Optional: Set user agent to mimic real browser
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/115.0.0.0 Safari/537.36");

    // Go to target URL and wait for network idle to ensure loading done
    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Get cookies set by the page
    const cookies = await page.cookies();

    // Get full page content (HTML)
    const content = await page.content();

    await browser.close();

    // Return JSON with cookies and HTML content (base64 encoded for safety)
    res.json({
      cookies,
      html: Buffer.from(content).toString("base64")
    });

  } catch (err) {
    if (browser) await browser.close();
    console.error("Browser-fetch error:", err);
    res.status(500).json({ error: "Failed to fetch page with browser emulation" });
  }
});
