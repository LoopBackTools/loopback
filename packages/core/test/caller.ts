import { REVISION } from "@loopbacktools/protocol/schema";
import type { Caller } from "../src/space/rpc.ts";

/** The tests' own code, naming no build, so no space ever finds it newer than itself. */
export const caller: Caller = { revision: REVISION };
