import {
  reactExtension,
  Badge,
  Banner,
  BlockStack,
  Button,
  Grid,
  Image,
  InlineStack,
  Spinner,
  Text,
  View,
  useApi,
  useApplyCartLinesChange,
  useBuyerJourneyIntercept,
  useCartLines,
  useSettings,
  useTranslate,
} from "@shopify/ui-extensions-react/checkout";
import { Component, useEffect, useState, type ReactNode } from "react";
import { fetchEligibleSellingPlansForVariants, type EligibleSellingPlan } from "./sellingPlans";
import type { CartLine } from "@shopify/ui-extensions/checkout";

const ONE_TIME_PURCHASE = "one-time-purchase";

// Fixed card height, so all options are the same box regardless of how much text each one
// carries. Roomy enough for a wrapped two-line label plus a detail line, and to keep the
// centred content clear of the badge overhanging the top border.
const CARD_MIN_BLOCK_SIZE = 90;
// Comfortably wider than the "Best value" pill, so the badge always has room for one line.
const BADGE_MIN_INLINE_SIZE = 100;

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
};

export default reactExtension("purchase.checkout.block.render", () => (
  <BannerErrorBoundary>
    <UpgradeBanner />
  </BannerErrorBoundary>
));

// Surfaces any render-time crash directly on checkout instead of failing silently, so a
// broken extension is diagnosable from the storefront without digging through DevTools.
class BannerErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.error) {
      return <Banner status="critical">Loop subscription widget error: {this.state.error}</Banner>;
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
      discountLabel: settings.one_time_purchase_note || null,
    },
  ];

  return (
    <BlockStack spacing="loose" padding="base" border="base" cornerRadius="base" inlineSize="fill">
      <Text emphasis="bold" size="large">
        {settings.banner_title || "Unlock Subscriber Benefits"}
      </Text>

      {settings.banner_image && (
        <Image source={settings.banner_image} cornerRadius="base" />
      )}

      {loading ? (
        // Proper loading state instead of showing the fallback cards while the real
        // eligibility check is still in flight — avoids flashing placeholder frequency
        // options that might not match what's actually available.
        <InlineStack spacing="tight" blockAlignment="center">
          <Spinner size="small" />
          <Text appearance="subdued" size="small">
            Checking this cart for eligible subscription products…
          </Text>
        </InlineStack>
      ) : (
        <>
          {!isLive && (
            <Text appearance="subdued" size="small">
              Preview — no eligible subscription product found in this cart yet.
            </Text>
          )}

          {applyError && <Banner status="critical">{translate("errorLabel")}</Banner>}

          <BlockStack spacing="loose" inlineSize="fill">
            <Text size="small" appearance="subdued" emphasis="bold">
              Frequency
            </Text>
            {/* Grid (not InlineStack) so every card gets an equal share of the row: InlineStack
                sizes each Button to its own label, which made "One-time purchase" much wider
                than the frequency cards. */}
            <Grid columns={cards.map(() => "fill")} spacing="base" inlineSize="fill">
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
            </Grid>
          </BlockStack>
        </>
      )}
    </BlockStack>
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
    // Relative wrapper purely so the badge can be positioned against the card's edges.
    <View position={{ type: "relative" }} inlineSize="fill">
      {/* Button has no sizing props, so it only fills its container when it is itself a grid
          item — nesting this single `fill` column is what keeps every card the same width
          now that the Button sits inside the positioning wrapper rather than in the row grid
          directly. */}
      <Grid columns={["fill"]} inlineSize="fill">
        <Button
          kind={selected ? "primary" : "secondary"}
          loading={pending}
          disabled={disabled}
          onPress={onPress}
          accessibilityLabel={badge ? `${label} — ${badge}` : label}
        >
          <View
            padding="extraTight"
            minBlockSize={CARD_MIN_BLOCK_SIZE}
            blockAlignment="center"
            inlineSize="fill"
          >
            <BlockStack spacing="extraTight" inlineAlignment="center">
              <Text emphasis="bold">{label}</Text>
              {shippingLabel && (
                <Text size="small" emphasis="bold">
                  {shippingLabel}
                </Text>
              )}
              {discountLabel && <Text size="small">{discountLabel}</Text>}
            </BlockStack>
          </View>
        </Button>
      </Grid>

      {/* Taken out of flow and pulled up by half its own height so it straddles the top
          border, centred on the card. Being absolute, it costs no layout height — the badged
          card stays exactly as tall as its neighbours without a reserved slot. */}
      {badge && (
        // Full-width strip rather than a 50%-inset box: an absolutely positioned element
        // shrink-to-fits within the space left after its inset, so anchoring at 50% capped
        // the badge at half the card and wrapped "Best value" onto two lines on mobile.
        // Spanning the card and centring inside it gives the badge the full width to sit on.
        <View
          position={{ type: "absolute", blockStart: 0, inlineStart: "50%" }}
          translate={{ block: "-50%", inline: "-50%" }}
        >
          {/* Centred by anchor maths, not by width: `inlineSize` has no effect on an
              absolutely positioned View here, so the box stays shrink-to-fit and no
              alignment prop inside it has room to work. Pinning its inline start to the
              card's midpoint and pulling it back by half its own width centres it whatever
              it measures. `blockAlignment` keeps the pill its natural height rather than
              stretching to the box.

              `minInlineSize` on this in-flow child is what stops the pill wrapping on
              mobile: anchored at 50%, the box would otherwise shrink to the half-card left
              over and break "Best value" across two lines. A child minimum raises the box's
              own min-content width, so it keeps the pill on one line and the translate
              still centres it. */}
          <InlineStack
            minInlineSize={BADGE_MIN_INLINE_SIZE}
            inlineAlignment="center"
            blockAlignment="center"
            spacing="none"
          >
            <Badge tone="critical" size="small">
              {badge}
            </Badge>
          </InlineStack>
        </View>
      )}
    </View>
  );
}
