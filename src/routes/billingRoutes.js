import express from "express";
import {
  createCreditPack,
  createCreditPackRazorpayOrder,
  createPlan,
  createRazorpayCheckoutOrder,
  deleteCreditPack,
  downloadMyInvoice,
  getMyCredits,
  getMySubscription,
  getPaygSettings,
  getWalletTransactions,
  listInvoices,
  listCreditPacks,
  listMyInvoices,
  listWallets,
  listPayments,
  listPlans,
  listSubscriptions,
  updateCreditPack,
  updatePaygSettings,
  updateVendorWallet,
  updatePlan,
  updateSubscription,
  verifyCreditPackRazorpayPayment,
  verifyRazorpayCheckoutPayment,
  viewMyInvoice,
} from "../controllers/billingController.js";
import { permitRoles, protectAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protectAdmin);

router.get("/me", getMySubscription);
router.get("/me/credits", getMyCredits);
router.get("/me/invoices", listMyInvoices);
router.get("/me/invoices/:id", viewMyInvoice);
router.get("/me/invoices/:id/download", downloadMyInvoice);
router.get("/plans", listPlans);
router.get("/credit-packs", listCreditPacks);
router.post("/razorpay/orders", createRazorpayCheckoutOrder);
router.post("/razorpay/verify", verifyRazorpayCheckoutPayment);
router.post("/razorpay/credit-orders", createCreditPackRazorpayOrder);
router.post("/razorpay/credit-verify", verifyCreditPackRazorpayPayment);

router.use(permitRoles("super_admin"));

router.post("/plans", createPlan);
router.patch("/plans/:id", updatePlan);
router.get("/payg-settings", getPaygSettings);
router.patch("/payg-settings", updatePaygSettings);
router.post("/credit-packs", createCreditPack);
router.patch("/credit-packs/:id", updateCreditPack);
router.delete("/credit-packs/:id", deleteCreditPack);
router.get("/wallets", listWallets);
router.get("/wallets/:vendorId/transactions", getWalletTransactions);
router.patch("/wallets/:vendorId", updateVendorWallet);
router.get("/subscriptions", listSubscriptions);
router.patch("/subscriptions/:id", updateSubscription);
router.get("/payments", listPayments);
router.get("/invoices", listInvoices);

export default router;
