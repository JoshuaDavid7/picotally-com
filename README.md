# picotally.com

Marketing site and legal docs for [Picotally](https://picotally.com), the
mobile invoicing app for tradespeople published by Pico Apps LLC.

## What's here

| File | URL | Purpose |
|---|---|---|
| `index.html` | `picotally.com/` | Landing page |
| `privacy.html` | `picotally.com/privacy` | Privacy policy (referenced by App Store Privacy questionnaire and the in-app paywall footer) |
| `terms.html` | `picotally.com/terms` | Terms of service (referenced by the in-app paywall footer) |
| `support.html` | `picotally.com/support` | Support contact page (Apple App Review requires a live support URL) |

## Hosting

Deployed via Cloudflare Pages. Pushes to `main` auto-deploy in ~30 seconds.

## Editing

Edit any `.html` file in this repo, commit, and push. Cloudflare Pages picks up
the change and serves it at picotally.com automatically.

If you change the entity name (currently "Pico Apps LLC"), update it in the
in-app paywall footer too — `lib/presentation/screens/paywall_screen.dart` in
the picotally-app repo.
