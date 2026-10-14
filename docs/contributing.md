# Contributing

1. Pick a phase-sized slice (see README feature list); keep PRs focused.
2. Add/extend tests under `tests/` — unit for logic, integration for flows (search → play, search → offline → playback).
3. Run `npm test` and `npm run build` before pushing.
4. Follow the provider rules in `docs/providers.md` — no unauthorized downloading/stream ripping.
5. Match the design language: dark-first, glass, rounded, subtle motion, honest empty/error/offline states for every screen.
6. Accessibility: labels, keyboard paths, focus states, reduced-motion respect.
