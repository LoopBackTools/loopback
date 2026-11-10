// Loads the Worker under test before any test runs. Its module graph is transformed the first time
// it is imported, which takes seconds; a test file would otherwise pay for it inside its first
// test's timeout.
import "./worker.ts";
