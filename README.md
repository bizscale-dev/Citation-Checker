# Citation Checker

Enter business info on the left and paste citation links on the right (one per line).
Each page is fetched by the local server and checked for name, phone, email and address.

- **Green**: found on the page
- **Amber**: close (some address or name words differ)
- **Red**: wrong or missing. The page's actual phone or email is shown when one was found
- **Gray**: the page couldn't be read. Use **Open in Chrome** or **Paste text**

## Use your own Chrome (VPN, logins) — recommended

Install the helper extension once:

1. Open `chrome://extensions` and turn on **Developer mode** (top right)
2. Click **Load unpacked** and pick the `chrome-extension` folder in this project
3. Reload the app. The bar above the Check button turns green: "Read pages with: My Chrome"

Each link then opens in a background tab of your Chrome (so your VPN extension, logins and cookies apply),
is read, and is closed again. Cards read this way are tagged **your Chrome**. If your Chrome can't show a page
(e.g. a broken SSL certificate) the server reads it instead. Pop-up alerts on the checked site are muted only
while it's being read.

## Blocked sites

1. Every link is fetched with a fast plain request first. If the site blocks it or needs JavaScript, it's loaded again
   in real Chrome running off-screen (tagged **via Chrome**).
2. **Captcha / bot check**: click **Open in Chrome**, solve it (or log in for owner links), close the window, click **Recheck**.
   That Chrome keeps its cookies in `.browser-profile/`, so you usually only do this once per site.
3. **Blocked by country** (e.g. BBB, Yelp from outside the US): copy `.env.example` to `.env`, set `PROXY_URL` to a US proxy,
   restart `npm run dev`. Or connect to a US VPN.

## Run

```
npm install
npm run dev
```

Open http://localhost:5173

Production: `npm run build && npm start` (serves on http://localhost:3001)

## Online version (Vercel)

Live at https://citation-checker-kohl.vercel.app (project `citation-checker`, team `developer-2077s-projects`).

- Deploys automatically: every push to `main` on https://github.com/bizscale-dev/Citation-Checker goes live.
  Manual deploy if ever needed: `vercel deploy --prod`
- The API runs as a Vercel function (`api/index.js` → `server/app.js`). The hidden-Chrome fallback is local-only.
- The helper extension works on the live site too (its address is in `chrome-extension/manifest.json`).
  If the address ever changes, update `matches` there and click reload on the extension in `chrome://extensions`.
