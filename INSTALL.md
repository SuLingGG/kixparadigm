# Install (DSH 0.2.2-rc.5)

1. Install DSH 0.2.2-rc.5 and run `dsh web` once so `$DSH_HOME/profiles/web` exists.
2. From this repository run `./install.sh`.
3. Restart `dsh web`; pick `kixparadigm` in the mode picker.

If the installer cannot locate the DSH runtime:

```bash
KIX_DSH_NODE_MODULES=/path/to/@deepseek-ai/dsh/node_modules ./install.sh
```

Verify:

```bash
node bin/kixparadigm.js doctor
```

Remove:

```bash
node bin/kixparadigm.js uninstall --revert-runtime
```
