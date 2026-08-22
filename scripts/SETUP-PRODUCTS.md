# Daily Catalog Sync — GitHub-only setup

No third party. A GitHub Action pulls your full catalog from Google Merchant Center once a day, commits `products.json`, and the website reads it on every visit.

```
Google Merchant Center ──(Merchant API v1)──> GitHub Action (daily 5:37am ET)
                                                   │
                                                   ▼
                                            products.json (committed)
                                                   │
                                                   ▼
                                     premium.html renders live cards + prices
```

## One-time setup

### Google side (~10 min)

1. Enable the **Merchant API** (the old Content API retired Aug 2026):
   [console.cloud.google.com/apis/library/merchantapi.googleapis.com](https://console.cloud.google.com/apis/library/merchantapi.googleapis.com) → Enable
2. **IAM & Admin → Service Accounts → Create** → name `mc-sync` → skip roles → open it → **Keys → Add key → Create new key → JSON** → download
3. [merchants.google.com](https://merchants.google.com) → gear ⚙ → **Account settings → People → Add user** → paste the service-account email (`mc-sync@<project>.iam.gserviceaccount.com`) → access **Standard**
4. Your **Merchant ID**: the number in your overview URL (`?a=1234567890`)

### Repo secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**, three times:

| Secret name | Value |
|---|---|
| `MERCHANT_ID` | e.g. `1234567890` |
| `GOOGLE_SA_EMAIL` | `mc-sync@…iam.gserviceaccount.com` |
| `GOOGLE_SA_KEY` | full private key incl. both `-----BEGIN/END PRIVATE KEY-----` lines (multi-line paste is fine; `\n`-escaped also works) |

Optional repo **variable** (not secret): `PRODUCTS_INCLUDE` — comma-separated keywords to filter (e.g. `fitness,exercise,vitamin`). Leave unset for the full catalog.

## Run it

- First run: repo **Actions tab → "Sync product catalog" → Run workflow**
- Afterwards it runs automatically every day and commits an updated `products.json`
- Check the Actions log for `Wrote products.json with N items.`

## How the site uses it

`premium.html` fetches `products.json` on every page load (`LIVE_PRODUCTS_URL = "products.json"` near the top of the script) and renders up to 48 cards with prices, sale prices and out-of-stock dimming, plus auto-generated category chips from your product types. Until the first successful run, or if the fetch ever fails, the static product cards remain as fallback.

## Security notes

- Secrets are AES-256 encrypted at rest, never printed in logs (auto-masked), and cannot be read back after saving — only overwritten.
- The credential is scoped to this one service account; revoke anytime by removing the SA user in Merchant Center or deleting the key in Cloud Console.
- Rotate: generate a new key, update the secret, delete the old key.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 / invalid_grant` | Key malformed — re-copy including BEGIN/END lines |
| `403 PERMISSION_DENIED` | SA email not added as People user in Merchant Center (step 3), or Merchant API not enabled (step 1) |
| `404` | Wrong `MERCHANT_ID` |
| `0 products fetched` | Products not yet ingested from your partnerupload feed, or all filtered by `PRODUCTS_INCLUDE` |
