// Migrated off @shopify/ui-extensions-react (React-based components), which Shopify stopped
// accepting new deploys for once api_version 2025-07 was cut off (~Oct 2026). From 2025-10
// onward, checkout UI extensions run on Preact with native `s-*` Polaris web components
// instead of the old View/BlockStack/Button/etc. component set — see shopify.extension.toml.
//
// The hook names (useApi, useCartLines, useApplyCartLinesChange, useBuyerJourneyIntercept,
// useSettings, useShippingAddress, useTranslate) are unchanged, just imported from
// "@shopify/ui-extensions/checkout/preact" instead of "@shopify/ui-extensions-react/checkout".
//
// Type-only reference that registers the `s-*` Polaris web component JSX types for this
// specific extension target (the generic "@shopify/ui-extensions/preact" entry point is
// empty; each target's component set lives under its own target-specific subpath instead).
// A triple-slash reference rather than a real import, since the target's ".d.ts" has no
// runtime JS counterpart — esbuild warned about it being dropped as a dead side-effect import.
/// <reference types="@shopify/ui-extensions/purchase.checkout.block.render" />
import { render, Component, type ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  useApi,
  useApplyCartLinesChange,
  useBuyerJourneyIntercept,
  useCartLines,
  useSettings,
  useShippingAddress,
  useTranslate,
} from "@shopify/ui-extensions/checkout/preact";
import { fetchEligibleSellingPlansForVariants, type EligibleSellingPlan } from "./sellingPlans";
import type { CartLine } from "@shopify/ui-extensions/checkout";

const ONE_TIME_PURCHASE = "one-time-purchase";

// Fixed card height, so all options are the same box regardless of how much text each one
// carries. Roomy enough for a wrapped two-line label plus a detail line.
const CARD_MIN_BLOCK_SIZE = "90px";

// Shown when no live eligible plan data is available yet (still loading, no eligible
// cart line found, or the query failed) so the banner is never fully invisible while
// we finish diagnosing the live data path with Loop's real metafields.
const FALLBACK_PLANS: EligibleSellingPlan[] = [
  { id: "fallback-weekly", label: "Every week", isDefault: true, discountLabel: null, shippingLabel: "Free shipping" },
  { id: "fallback-biweekly", label: "Every 2 weeks", isDefault: false, discountLabel: null, shippingLabel: "Free shipping" },
];

type ExtensionSettings = {
  banner_title?: string;
  banner_image?: string;
  one_time_purchase_note?: string;
  remote_one_time_purchase_note?: string;
};

// Australian states with higher one-time-purchase shipping. Checked against the shipping
// address's provinceCode (e.g. "WA"), which Shopify only returns once this app has Level 2
// "protected customer data" access approved in the Partner Dashboard — until then
// useShippingAddress() returns undefined and this surcharge note never applies, so the
// widget just falls back to the standard one_time_purchase_note instead of breaking.
const REMOTE_SHIPPING_PROVINCE_CODES = ["WA", "TAS"];

export default function extension() {
  render(
    <BannerErrorBoundary>
      <UpgradeBanner />
    </BannerErrorBoundary>,
    document.body,
  );
}

// Surfaces any render-time crash directly on checkout instead of failing silently, so a
// broken extension is diagnosable from the storefront without digging through DevTools.
class BannerErrorBoundary extends Component<{ children: ComponentChildren }, { error: string | null }> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.error) {
      return <s-banner tone="critical">Loop subscription widget error: {this.state.error}</s-banner>;
    }
    return this.props.children;
  }
}

// Finds every cart line (in cart order) with at least one checkout-eligible Loop selling
// plan — not just the first — so a shopper with several subscribable products in their
// cart gets all of them upgraded, not only whichever happened to be first. All eligible
// lines are assumed to share the same plan list (Loop's own selling-plan-group-per-collection
// model means this holds in practice); the first eligible line's plans are used to render
// the shared card row. Only variant ids (a stable key) are stored — the cart lines
// themselves are looked up fresh from `cartLines` on every render, since line
// ids/attributes/sellingPlan are not stable across `applyCartLinesChange` calls.
function useEligibleUpgradeLines(cartLines: CartLine[]) {
  const { query } = useApi();
  const [result, setResult] = useState<{ variantIds: string[]; plans: EligibleSellingPlan[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const candidateKey = cartLines.map((line) => line.merchandise.id).join(",");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function findEligibleLines() {
      const eligibleVariantIds: string[] = [];
      let sharedPlans: EligibleSellingPlan[] | null = null;

      try {
        // One batched request for every cart line's variant, instead of one request per
        // line awaited in series — this is what actually cuts checkout load time, since a
        // multi-item cart previously paid N sequential round-trips before the widget settled.
        const plansByVariantId = await fetchEligibleSellingPlansForVariants(
          query,
          cartLines.map((line) => line.merchandise.id),
        );
        if (cancelled) return;

        for (const line of cartLines) {
          const plans = plansByVariantId.get(line.merchandise.id) ?? [];
          if (plans.length > 0) {
            eligibleVariantIds.push(line.merchandise.id);
            if (!sharedPlans) sharedPlans = plans;
          }
        }
      } catch {
        // Leave both empty — falls through to the non-live/fallback state below.
      }

      if (cancelled) return;
      setResult(eligibleVariantIds.length > 0 && sharedPlans ? { variantIds: eligibleVariantIds, plans: sharedPlans } : null);
      setLoading(false);
    }

    findEligibleLines();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey, query]);

  return { result, loading };
}

function UpgradeBanner() {
  const translate = useTranslate();
  const settings = useSettings<ExtensionSettings>();
  const shippingAddress = useShippingAddress();
  const cartLines = useCartLines();
  const applyCartLinesChange = useApplyCartLinesChange();
  const { result, loading } = useEligibleUpgradeLines(cartLines);

  // Holds the buyer on the current step (disabling e.g. "Pay now") while we're still
  // checking eligibility or applying the default plan, so they can't complete checkout
  // before the widget has settled into its real state.
  useBuyerJourneyIntercept(({ canBlockProgress }) => {
    if (canBlockProgress && loading) {
      return {
        behavior: "block",
        reason: "Loop subscription widget is still loading eligible plans.",
      };
    }
    return { behavior: "allow" };
  });

  const isLive = result !== null;
  const plans = result?.plans ?? FALLBACK_PLANS;
  // Re-derived every render from the stable variant ids, since cart line
  // ids/attributes/sellingPlan mutate after applyCartLinesChange and a stored reference
  // would go stale. This is every eligible line, not just one.
  const currentLines = result
    ? cartLines.filter((line) => result.variantIds.includes(line.merchandise.id))
    : [];

  const [selectedId, setSelectedId] = useState<string>(ONE_TIME_PURCHASE);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState(false);

  // Applies one selling plan (or null for one-time) to every given line — a shopper with
  // several eligible products in cart gets all of them upgraded together, since the widget
  // shows a single shared frequency choice rather than one control per line. Fired
  // concurrently rather than awaited one at a time in series: a 5-item cart previously took
  // 5x the round-trip time to finish applying the default plan before the widget settled.
  async function applyPlanToLines(lines: CartLine[], sellingPlanId: string | null) {
    const responses = await Promise.all(
      lines.map((line) =>
        applyCartLinesChange({
          type: "updateCartLine",
          id: line.id,
          sellingPlanId,
          attributes: [...line.attributes],
        }),
      ),
    );
    return responses.every((response) => response.type !== "error");
  }

  // Clicking a card applies the change immediately — no separate confirm button.
  async function selectPlan(planId: string) {
    if (currentLines.length === 0 || planId === selectedId || pendingId) return;
    setPendingId(planId);
    setApplyError(false);
    const ok = await applyPlanToLines(currentLines, planId === ONE_TIME_PURCHASE ? null : planId);
    setPendingId(null);
    if (!ok) {
      setApplyError(true);
      return;
    }
    setSelectedId(planId);
  }

  useEffect(() => {
    if (!result || currentLines.length === 0) return;
    const lineWithPlan = currentLines.find((line) => line.merchandise.sellingPlan);
    if (lineWithPlan) {
      // At least one eligible line already has a plan (e.g. shopper picked one earlier) —
      // just reflect it, and bring any other eligible line that's missing it into line.
      setSelectedId(lineWithPlan.merchandise.sellingPlan!.id);
      const linesMissingPlan = currentLines.filter((line) => !line.merchandise.sellingPlan);
      if (linesMissingPlan.length > 0) {
        applyPlanToLines(linesMissingPlan, lineWithPlan.merchandise.sellingPlan!.id);
      }
      return;
    }
    // No eligible line has a plan yet: the highlighted "default" must actually be applied
    // via the API, not just shown as selected — otherwise a shopper who never touches the
    // widget gets charged one-time despite the UI implying the default plan was active.
    const defaultPlan = plans.find((plan) => plan.isDefault);
    if (defaultPlan) {
      selectPlan(defaultPlan.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // One-time purchase costs more to ship to WA/TAS — swap in the merchant's configured
  // remote-shipping note when the buyer's province matches, otherwise show the standard note.
  const isRemoteShippingProvince = Boolean(
    shippingAddress?.provinceCode &&
      REMOTE_SHIPPING_PROVINCE_CODES.includes(shippingAddress.provinceCode.toUpperCase()),
  );
  const oneTimePurchaseNote = isRemoteShippingProvince
    ? settings.remote_one_time_purchase_note || settings.one_time_purchase_note || null
    : settings.one_time_purchase_note || null;

  // One flat list so the frequency plans and one-time purchase render as identical cards in
  // the same equal-width grid, instead of the one-time option being a differently-built card.
  const cards = [
    ...plans.map((plan) => ({
      id: plan.id,
      label: plan.label,
      badge: plan.isDefault ? translate("popularBadge") : null,
      shippingLabel: plan.shippingLabel,
      discountLabel: plan.discountLabel,
    })),
    {
      id: ONE_TIME_PURCHASE,
      label: translate("oneTimePurchase"),
      badge: null,
      shippingLabel: null,
      discountLabel: oneTimePurchaseNote,
    },
  ];

  return (
    // "base" on this design system's gap scale turned out to be a much bigger vertical gap
    // in practice than its "base" padding counterpart — swapped to "small" to actually match
    // the old tight layout, since there's no documented px mapping to compute this up front.
    <s-stack direction="block" gap="small" padding="base" border="base" borderRadius="base" inlineSize="100%">
      {/* s-heading carries its own large built-in margin with no prop to reduce it, which
          was stacking with our own gap and blowing out the space below the title — s-text
          has no such built-in margin, so it's used here instead for a tighter, title-like line. */}
      <s-text type="strong">{settings.banner_title || "Unlock Subscriber Benefits"}</s-text>

      {/* s-image defaults aspectRatio to '1/1' (a forced square) when inlineSize="fill", then
          object-fit:contain centers the real (wide, short) banner graphic inside that square —
          that forced square box, not stack gap, was the real source of the huge empty bands
          above/below the banner. aspectRatio is set here to roughly match this banner's actual
          proportions; a merchant uploading a differently-shaped image may need this adjusted. */}
      {settings.banner_image && (
        <s-image src={settings.banner_image} aspectRatio="7/3" borderRadius="base" />
      )}

      {loading ? (
        // Proper loading state instead of showing the fallback cards while the real
        // eligibility check is still in flight — avoids flashing placeholder frequency
        // options that might not match what's actually available.
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-spinner size="small" />
          <s-text type="small" color="subdued">
            Checking this cart for eligible subscription products…
          </s-text>
        </s-stack>
      ) : (
        <>
          {!isLive && (
            <s-text type="small" color="subdued">
              Preview — no eligible subscription product found in this cart yet.
            </s-text>
          )}

          {applyError && <s-banner tone="critical">{translate("errorLabel")}</s-banner>}

          <s-stack direction="block" gap="small" inlineSize="100%">
            <s-text type="small" color="subdued">
              Frequency
            </s-text>
            <s-grid
              gridTemplateColumns={`repeat(${cards.length}, 1fr)`}
              gap="small"
              alignItems="end"
              inlineSize="100%"
            >
              {cards.map((card) => (
                <PlanCard
                  key={card.id}
                  label={card.label}
                  badge={card.badge}
                  shippingLabel={card.shippingLabel}
                  discountLabel={card.discountLabel}
                  selected={selectedId === card.id}
                  pending={pendingId === card.id}
                  disabled={!isLive || pendingId !== null}
                  onPress={() => selectPlan(card.id)}
                />
              ))}
            </s-grid>
          </s-stack>
        </>
      )}
    </s-stack>
  );
}

function PlanCard({
  label,
  badge,
  shippingLabel,
  discountLabel,
  selected,
  pending,
  disabled,
  onPress,
}: {
  label: string;
  badge?: string | null;
  shippingLabel?: string | null;
  discountLabel?: string | null;
  selected: boolean;
  pending: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    // A badge can't straddle the border here: no position/translate props, and
    // s-grid-item's gridRow/gridColumn only accept "auto" or "span N", so cells can't overlap.
    // Closest achievable: the badge sits directly on top of the card's border, touching it.
    // The row grid bottom-aligns its cells, so the badged card's extra height goes above its
    // button and every button's top border still lines up with its neighbours.
    <s-stack direction="block" gap="none" inlineSize="100%">
      {badge && (
        <s-stack direction="block" alignItems="center" inlineSize="100%">
          <s-badge tone="critical" size="small">
            {badge}
          </s-badge>
        </s-stack>
      )}
      <s-button
        variant={selected ? "primary" : "secondary"}
        loading={pending}
        disabled={disabled}
        inlineSize="fill"
        onClick={onPress}
        accessibilityLabel={badge ? `${label} — ${badge}` : label}
      >
        <s-stack
          direction="block"
          gap="small-200"
          padding="small-200"
          minBlockSize={CARD_MIN_BLOCK_SIZE}
          justifyContent="center"
          alignItems="center"
          inlineSize="100%"
        >
          <s-text type="strong">{label}</s-text>
          {shippingLabel && <s-text type="strong">{shippingLabel}</s-text>}
          {discountLabel && <s-text type="small">{discountLabel}</s-text>}
        </s-stack>
      </s-button>
    </s-stack>
  );
}
