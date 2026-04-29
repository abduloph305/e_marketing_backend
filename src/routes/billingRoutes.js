import express from "express";
import {
  createPlan,
  createRazorpayCheckoutOrder,
  downloadMyInvoice,
  getMySubscription,
  listInvoices,
  listMyInvoices,
  listPayments,
  listPlans,
  listSubscriptions,
  updatePlan,
  updateSubscription,
  verifyRazorpayCheckoutPayment,
  viewMyInvoice,
} from "../controllers/billingController.js";
import { permitRoles, protectAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protectAdmin);

router.get("/me", getMySubscription);
router.get("/me/invoices", listMyInvoices);
router.get("/me/invoices/:id", viewMyInvoice);
router.get("/me/invoices/:id/download", downloadMyInvoice);
router.get("/plans", listPlans);
router.post("/razorpay/orders", createRazorpayCheckoutOrder);
router.post("/razorpay/verify", verifyRazorpayCheckoutPayment);

router.use(permitRoles("super_admin"));

router.post("/plans", createPlan);
router.patch("/plans/:id", updatePlan);
router.get("/subscriptions", listSubscriptions);
router.patch("/subscriptions/:id", updateSubscription);
router.get("/payments", listPayments);
router.get("/invoices", listInvoices);

export default router;
