import mongoose from "mongoose";

const sellersLoginWebsiteSchema = new mongoose.Schema(
  {
    vendor_id: {
      type: mongoose.Schema.Types.Mixed,
      index: true,
    },
    template_key: String,
    template_name: String,
    name: String,
    business_name: String,
    website_slug: String,
    is_default: Boolean,
    createdAt: Date,
  },
  {
    collection: "templatebases",
    strict: false,
  },
);

const SellersLoginWebsite =
  mongoose.models.SellersLoginWebsite ||
  mongoose.model("SellersLoginWebsite", sellersLoginWebsiteSchema);

export default SellersLoginWebsite;
