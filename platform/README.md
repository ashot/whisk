# platform

The parts of the shared engine Whisk is built on, the same packages Codecast
runs on: the local-first sync engine (`engine`, `engine-convex`), auth,
crypto, push, the key binding engine, the Electron shell (`desktop`), design
tokens, and the CLI kit and agent snippet installer the `whisk` CLI uses.
They are vendored here so this repository builds on its own.
