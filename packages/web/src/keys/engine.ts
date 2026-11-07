// whisk's binding to the shared keyboard engine.
//
// The engine itself lives in @platform/keys (repo ~/src/platform). This file
// stays as the path the app imports so component code does not churn; the
// bindings whisk registers against the engine live in ./bindings.

export * from "@platform/keys";
