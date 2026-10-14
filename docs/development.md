# Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest (jsdom + fake-indexeddb)
npm run build      # tsc + vite build + PWA service worker -> dist/
```

## Conventions

- TypeScript strict; `npm run typecheck` must pass.
- UI components stay small and screen-specific; shared pieces live in `src/ui/`.
- No fake features: if the platform can't do it (e.g. web EQ), say so in the UI.
- Never log secrets; `src/core/logger.ts` redacts sensitive keys and caps local logs at 300 lines.
- User-visible strings should go through `src/i18n/` (English default).
