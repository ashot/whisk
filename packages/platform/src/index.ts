// @mail/platform — whisk's binding to the shared engine.
//
// The engine itself lives in @platform/engine (repo ~/src/platform), shared with
// aurora and, later, codecast. This package stays as the name whisk imports so
// app code does not churn: it re-exports the engine surface unchanged, and is
// where any whisk-only addition to that surface would go.

export * from "@platform/engine";
