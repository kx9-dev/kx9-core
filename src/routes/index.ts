import { Router, type IRouter } from "express";
import healthRouter from "./health";
import rpcRouter from "./rpc";
import coreRouter from "./core";

const router: IRouter = Router();

router.use(healthRouter);
router.use(rpcRouter);
router.use("/v1", coreRouter);

export default router;
