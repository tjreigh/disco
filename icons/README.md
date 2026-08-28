# Icons

Favicon and PWA install icons. The build copies `icons/*.png` and `icons/*.svg`
into `public/icons/` (this README is not copied).

The current set is a generated geometric mark — concentric rings on the brand
navy (`#1a1a2e`) in the accent blues. Regenerate with:

```
node scripts/make-icons.mjs
```

To use real artwork instead, replace these files in place, keeping the same
names and sizes:

| File | Size | Notes |
| --- | --- | --- |
| `favicon.svg` | vector | Primary favicon |
| `favicon-32.png` | 32×32 | PNG fallback favicon |
| `favicon-16.png` | 16×16 | Small favicon fallback |
| `icon-192.png` | 192×192 | Manifest icon, `purpose: any` |
| `icon-512.png` | 512×512 | Manifest icon, `purpose: any` |
| `icon-maskable-192.png` | 192×192 | Manifest icon, `purpose: maskable` — keep the mark inside the inner 80% |
| `icon-maskable-512.png` | 512×512 | Manifest icon, `purpose: maskable` |
| `apple-touch-icon.png` | 180×180 | iOS home-screen icon, opaque background |

Referenced from `manifest.webmanifest` (the four `icon-*`) and `index.html`
(`favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`).
