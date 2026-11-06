import type { ApiRoute } from "@mastra/core/server";

import { docsChatRoute } from "./docs-chat";

/** Custom API routes registered on the Mastra server. */
export const customApiRoutes: ApiRoute[] = [docsChatRoute];
