import { createRouter } from "@/lib/create-app.ts";
import * as routes from "./memory.routes.ts";
import * as handlers from "./memory.handlers.ts";
import { memoryServer } from "@/routes/storage/memory.ts";

const router = createRouter();
router.all(
  "/api/storage/memory/archive",
  (context) => memoryServer.handleArchiveRequest(context.req.raw),
);

const Router = router.openapi(routes.subscribe, handlers.subscribe);

export default Router;
