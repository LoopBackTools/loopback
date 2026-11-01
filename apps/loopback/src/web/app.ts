import { createLoopbackApp } from "@loopbacktools/app";
import { session, workspaces } from "./session.ts";

/** The app as this Worker serves it: signed in with the deployment's token, opening its one space. */
export const App = createLoopbackApp({ session, workspaces });
