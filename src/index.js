import puppeteer from "@cloudflare/puppeteer";

// Common unsubscribe button/link selectors and text patterns
const UNSUB_SELECTORS = [
  // Direct unsubscribe buttons/links
  'a[href*="unsubscribe"]',
  'button[class*="unsubscribe"]',
  'input[type="submit"][value*="nsubscribe"]',
  'button:has-text("Unsubscribe")',
  // Confirm buttons on unsubscribe pages
  'button[type="submit"]',
  'input[type="submit"]',
  'a.btn',
  'a.button',
];

const CONFIRM_TEXT_PATTERNS = [
  /unsubscribe/i,
  /confirm/i,
  /opt.?out/i,
  /remove/i,
  /yes.*unsubscribe/i,
  /submit/i,
  /stop.*emails/i,
  /stop.*sending/i,
];

// Klaviyo / SPA-rendered unsubscribe page handler
// Covers manage.kmail-lists.com and similar Klaviyo-powered preference pages
// that render confirm buttons via JavaScript after initial page load.
async function handleKlaviyoPage(page) {
  console.log("Detected Klaviyo page — waiting for SPA render...");

  // Klaviyo pages render their UI via JS; give the SPA time to hydrate
  await new Promise((r) => setTimeout(r, 3000));

  // Strategy A: Look for a visible confirm/unsubscribe button rendered by the SPA
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('button, a, input[type="submit"], [role="button"]')
    );
    const patterns = [
      /unsubscribe/i,
      /confirm/i,
      /opt.?out/i,
      /yes/i,
      /submit/i,
    ];

    for (const el of candidates) {
      const text = el.textContent || el.value || "";
      const isVisible =
        el.offsetParent !== null &&
        getComputedStyle(el).display !== "none" &&
        getComputedStyle(el).visibility !== "hidden";

      if (isVisible && patterns.some((p) => p.test(text))) {
        el.click();
        return { clicked: true, text: text.trim().slice(0, 60) };
      }
    }
    return { clicked: false };
  });

  if (clicked.clicked) {
    console.log(`Klaviyo: clicked button with text "${clicked.text}"`);
    return true;
  }

  // Strategy B: Some Klaviyo pages use a form POST behind the scenes —
  // try submitting the first visible form on the page
  const formSubmitted = await page.evaluate(() => {
    const form = document.querySelector("form");
    if (form) {
      const btn = form.querySelector(
        'button[type="submit"], input[type="submit"], button:not([type])'
      );
      if (btn) {
        btn.click();
        return true;
      }
      // Last resort: submit the form directly
      form.submit();
      return true;
    }
    return false;
  });

  if (formSubmitted) {
    console.log("Klaviyo: submitted form directly");
    return true;
  }

  console.log("Klaviyo: could not find confirm element");
  return false;
}

function isKlaviyoUrl(url) {
  return /manage\.kmail-lists\.com|klaviyo\.com\/unsubscribe/i.test(url);
}

async function processUnsubscribeUrl(browser, url, email) {
  const result = { url, status: "pending", message: "", screenshots: [] };

  let page;
  try {
    page = await browser.newPage();

    // Set a reasonable viewport and user agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Navigate to the unsubscribe URL
    console.log(`Navigating to: ${url}`);
    const response = await page.goto(url, {
      waitUntil: "networkidle0",
      timeout: 30000,
    });

    if (!response) {
      result.status = "error";
      result.message = "No response from URL";
      return result;
    }

    const statusCode = response.status();
    const pageContent = await page.content();
    const pageText = await page.evaluate(() => document.body?.innerText || "");

    // Check if we already landed on a "you've been unsubscribed" page
    if (
      /you.*(have been|are|'ve been).*unsubscribed/i.test(pageText) ||
      /successfully.*unsubscribed/i.test(pageText) ||
      /removed.*from.*list/i.test(pageText) ||
      /no longer.*receive/i.test(pageText) ||
      /unsubscribe.*successful/i.test(pageText) ||
      /you.*been.*removed/i.test(pageText)
    ) {
      result.status = "success";
      result.message = "Unsubscribed (single-click worked)";
      return result;
    }

    // --- Klaviyo SPA handler ---
    if (isKlaviyoUrl(url)) {
      const klaviyoClicked = await handleKlaviyoPage(page);
      if (klaviyoClicked) {
        // Wait for navigation or content change after Klaviyo click
        try {
          await page.waitForNavigation({ timeout: 10000, waitUntil: "networkidle0" });
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
        }

        const finalText = await page.evaluate(() => document.body?.innerText || "");

        if (
          /you.*(have been|are|'ve been).*unsubscribed/i.test(finalText) ||
          /successfully/i.test(finalText) ||
          /removed/i.test(finalText) ||
          /no longer/i.test(finalText) ||
          /updated/i.test(finalText) ||
          /preferences.*saved/i.test(finalText) ||
          /thank you/i.test(finalText)
        ) {
          result.status = "success";
          result.message = "Unsubscribed via Klaviyo SPA confirm";
        } else {
          result.status = "likely_success";
          result.message =
            "Clicked Klaviyo confirm button. Page response unclear — may need manual verification.";
        }
        return result;
      }
      // If Klaviyo handler didn't find a button, fall through to generic logic
    }

    // Look for email input fields — fill them if found
    const emailInput = await page.$(
      'input[type="email"], input[name*="email"], input[placeholder*="email"], input[id*="email"]'
    );
    if (emailInput && email) {
      console.log("Found email input, filling...");
      await emailInput.click({ clickCount: 3 }); // select all
      await emailInput.type(email);
      result.message += "Filled email. ";
    }

    // Try to find and click an unsubscribe/confirm button
    let clicked = false;

    // Strategy 1: Find buttons/links with unsubscribe-related text
    const clickableElements = await page.$$(
      'button, input[type="submit"], a.btn, a.button, a[role="button"]'
    );

    for (const el of clickableElements) {
      const text = await page.evaluate((e) => e.textContent || e.value || "", el);
      const isUnsub = CONFIRM_TEXT_PATTERNS.some((pattern) => pattern.test(text));
      if (isUnsub) {
        console.log(`Clicking element with text: "${text.trim().slice(0, 50)}"`);
        try {
          await el.click();
          clicked = true;
          break;
        } catch (e) {
          console.log(`Click failed: ${e.message}`);
        }
      }
    }

    // Strategy 2: If no button found, try form submission
    if (!clicked) {
      const form = await page.$("form");
      if (form) {
        const submitBtn = await form.$(
          'button[type="submit"], input[type="submit"], button:not([type])'
        );
        if (submitBtn) {
          console.log("Clicking form submit button");
          await submitBtn.click();
          clicked = true;
        }
      }
    }

    if (clicked) {
      // Wait for navigation or content change
      try {
        await page.waitForNavigation({ timeout: 10000, waitUntil: "networkidle0" });
      } catch {
        // Page may not navigate, just update content
        await new Promise((r) => setTimeout(r, 3000));
      }

      const finalText = await page.evaluate(() => document.body?.innerText || "");

      if (
        /you.*(have been|are|'ve been).*unsubscribed/i.test(finalText) ||
        /successfully/i.test(finalText) ||
        /removed/i.test(finalText) ||
        /no longer/i.test(finalText) ||
        /updated/i.test(finalText) ||
        /preferences.*saved/i.test(finalText) ||
        /thank you/i.test(finalText)
      ) {
        result.status = "success";
        result.message += "Confirmed unsubscribe";
      } else {
        result.status = "likely_success";
        result.message += "Clicked confirm button. Page response unclear — may need manual verification.";
      }
    } else {
      // No button to click — check if the GET request itself was enough
      if (statusCode === 200 || statusCode === 302) {
        result.status = "likely_success";
        result.message =
          "Page loaded (no confirm button found). Many unsub links process on load. Check if emails stop.";
      } else {
        result.status = "needs_manual";
        result.message = `Page returned status ${statusCode}. Could not find confirm button. Manual action needed.`;
      }
    }
  } catch (error) {
    result.status = "error";
    result.message = `Error: ${error.message}`;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {}
    }
  }

  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Simple auth check
    const authHeader = request.headers.get("Authorization");
    if (authHeader !== `Bearer ${env.AUTH_SECRET}`) {
      // Allow GET on root for health check
      if (url.pathname === "/" && request.method === "GET") {
        return new Response(
          JSON.stringify({
            service: "Inbox Pilot Unsubscribe Agent",
            status: "ready",
            usage: "POST /unsub with JSON body: { email, urls: [...] }",
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === "/unsub" && request.method === "POST") {
      const body = await request.json();
      const { urls, email } = body;

      if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return new Response(
          JSON.stringify({ error: "Provide an array of URLs in 'urls'" }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }

      // Cap at 10 URLs per request to stay within browser time limits
      const urlsToProcess = urls.slice(0, 10);
      const results = [];

      let browser;
      try {
        browser = await puppeteer.launch(env.BROWSER);

        for (const unsubUrl of urlsToProcess) {
          console.log(`Processing: ${unsubUrl}`);
          const result = await processUnsubscribeUrl(browser, unsubUrl, email);
          results.push(result);
          console.log(`Result: ${result.status} - ${result.message}`);
        }
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: `Browser launch failed: ${error.message}`,
            results,
          }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      } finally {
        if (browser) {
          try {
            await browser.close();
          } catch {}
        }
      }

      const summary = {
        total: results.length,
        success: results.filter((r) => r.status === "success").length,
        likely_success: results.filter((r) => r.status === "likely_success").length,
        needs_manual: results.filter((r) => r.status === "needs_manual").length,
        errors: results.filter((r) => r.status === "error").length,
      };

      return new Response(JSON.stringify({ summary, results }, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
