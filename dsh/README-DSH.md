# DSH-side assets

- `preset/` — default kix paradigm preset, installed as `kixparadigm`
- `preset-classic/` — classic full-text preset, installed as `kixparadigm-classic`
- `preset-null/` — ablation control, not installed
- `children/` (inside `preset/`) — role subagent presets (`kix-lite`, `kix-reviewer`, `kix-qa`, `kix-dev`)
- `vision-bridge/` — seamless image-input bridge plugin

Installation, profile declarations, and the 0.2.2 runtime patch are handled by
`scripts/install-lib.js`. See the repository root `README.md` for usage and
`docs/dsh-0.2.2-compat.md` for the compatibility analysis.
