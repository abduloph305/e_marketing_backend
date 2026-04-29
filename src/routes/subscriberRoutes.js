import express from "express";
import {
  bulkSuppressSubscribers,
  bulkReactivateSubscribers,
  bulkTagSubscribers,
  bulkUnsubscribeSubscribers,
  listSubscribers,
  filterSubscribers,
  getSubscriberById,
  getSubscriberMeta,
  getSubscriberSummary,
  importSubscribersFromCsv,
  syncMyVendorAudience,
  createSubscriber,
  updateSubscriber,
  deleteSubscriber,
} from "../controllers/subscriberController.js";
import { protectAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protectAdmin);

router.get("/meta", getSubscriberMeta);
router.get("/summary", getSubscriberSummary);
router.post("/sync/sellerslogin", syncMyVendorAudience);
router.get("/", listSubscribers);
router.post("/filter", filterSubscribers);
router.post("/bulk/tags", bulkTagSubscribers);
router.post("/bulk/unsubscribe", bulkUnsubscribeSubscribers);
router.post("/bulk/suppress", bulkSuppressSubscribers);
router.post("/bulk/reactivate", bulkReactivateSubscribers);
router.post("/import/csv", importSubscribersFromCsv);
router.get("/:id", getSubscriberById);
router.post("/", createSubscriber);
router.put("/:id", updateSubscriber);
router.delete("/:id", deleteSubscriber);

export default router;
