# Inbox Pilot — Unsubscribe Agent

A Cloudflare Worker that uses Browser Rendering (headless Chrome) to automatically visit unsubscribe URLs, fill in your email if needed, and click confirm buttons.

## How it works

1. POST a list of unsubscribe URLs + your email
2. Worker spins up headless Chrome on Cloudflare's edge
3. Visits each URL, detects if already unsubscribed
4. Fills email fields and clicks confirm buttons
5. Returns a status report for each URL

## Deploy

### Option 1: Cloudflare Dashboard (connect to GitHub)
1. Go to Cloudflare Dashboard → Workers & Pages → Create
2. Connect this GitHub repo
3. Add a Browser Rendering binding named `BROWSER`
4. Add environment variable `AUTH_SECRET` = your secret key
5. Deploy

### Option 2: Wrangler CLI
```bash
npm install
npx wrangler deploy
```

## Usage

```bash
curl -X POST https://inbox-pilot-unsub.YOUR_SUBDOMAIN.workers.dev/unsub \
  -H "Authorization: Bearer inbox-pilot-2026" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "you@gmail.com",
    "urls": [
      "https://manage.kmail-lists.com/subscriptions/unsubscribe?a=...",
      "https://example.com/unsubscribe?token=..."
    ]
  }'
```

## Response

```json
{
  "summary": {
    "total": 2,
    "success": 1,
    "likely_success": 1,
    "errors": 0
  },
  "results": [
    {
      "url": "https://...",
      "status": "success",
      "message": "Unsubscribed (single-click worked)"
    }
  ]
}
```

## Limits

- Max 10 URLs per request (Browser Rendering time limits)
- Auth required via Bearer token
- Free plan: 10 min/day browser time. Paid plan: more.

## Part of Inbox Pilot

This is the unsubscribe automation component of the Inbox Pilot email management system built with Claude.
