// TEMP-TEST VALUES — Loop support hasn't confirmed the real keys yet (their own
// "Checkout upgrades" feature doesn't appear to write these via metafields on this
// store; SellingPlan/Product/Variant metafields were all checked and came back empty).
// These point at test metafields we wrote by hand via metafieldsSet on selling plans
// 4117856354 / 4117889122 for end-to-end verification. Swap back to Loop's real
// namespace/key once support replies, then delete this comment.
//
// Storefront API's `metafield` field takes `namespace` and `key` as separate arguments
// (confirmed against shopify.dev/docs/api/storefront/latest/objects/SellingPlan) — not a
// single combined "namespace.key" string, which is what this file previously held.
export const CHECKOUT_UPGRADE_METAFIELD = { namespace: "custom", key: "checkout_available" };
export const DEFAULT_SELLING_PLAN_METAFIELD = { namespace: "custom", key: "is_default" };
export const SELLING_PLAN_GROUP_POSITION_METAFIELD = { namespace: "custom", key: "group_position" };
// Optional per-plan benefit text (e.g. "Free shipping") — same test-metafield pattern as
// above. Not part of Loop's original 3-key doc; merchant sets this per plan once the real
// Loop equivalent (if any) is confirmed, or it stays a store-configured value.
export const SHIPPING_LABEL_METAFIELD = { namespace: "custom", key: "shipping_label" };
