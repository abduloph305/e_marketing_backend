const eligibleEmailStatuses = new Set(["subscribed"]);

const isSpamBlockedSubscriber = (subscriber = null) =>
  Boolean(subscriber && subscriber.status === "blocked" && subscriber.blockedReason === "spam");

const isSubscriberEligibleForEmail = (subscriber = null) =>
  Boolean(subscriber && eligibleEmailStatuses.has(String(subscriber.status || "").trim().toLowerCase())) &&
  !isSpamBlockedSubscriber(subscriber);

export { eligibleEmailStatuses, isSpamBlockedSubscriber, isSubscriberEligibleForEmail };
