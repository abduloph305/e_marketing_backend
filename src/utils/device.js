const inferDeviceType = (userAgent = "") => {
  const value = String(userAgent || "").toLowerCase();

  if (!value) return "";
  if (value.includes("ipad") || value.includes("tablet")) return "tablet";
  if (value.includes("mobile") || value.includes("android") || value.includes("iphone")) {
    return "mobile";
  }
  return "desktop";
};

export { inferDeviceType };
