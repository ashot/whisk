// The app entry. The background push task must exist before the router
// loads, and in a headless run (no app mounted) it is the only thing that
// runs.
import "./lib/backgroundPush";
import "expo-router/entry";
