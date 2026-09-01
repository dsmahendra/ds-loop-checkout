import {
  CHECKOUT_UPGRADE_METAFIELD,
  DEFAULT_SELLING_PLAN_METAFIELD,
  SELLING_PLAN_GROUP_POSITION_METAFIELD,
  SHIPPING_LABEL_METAFIELD,
} from "./loopMetafields";

const ELIGIBLE_SELLING_PLANS_QUERY = `#graphql
  query LoopEligibleSellingPlans(
    $id: ID!
    $checkoutUpgradeNamespace: String!
    $checkoutUpgradeKey: String!
    $defaultSellingPlanNamespace: String!
    $defaultSellingPlanKey: String!
    $groupPositionNamespace: String!
    $groupPositionKey: String!
    $shippingLabelNamespace: String!
    $shippingLabelKey: String!
  ) {
    node(id: $id) {
      ... on ProductVariant {
        sellingPlanAllocations(first: 10) {
          edges {
            node {
              sellingPlan {
                id
                name
                billingPolicy {
                  ... on SellingPlanRecurringBillingPolicy {
                    interval
                    intervalCount
                  }
                }
                priceAdjustments {
                  adjustmentValue {
                    ... on SellingPlanPercentagePriceAdjustment {
                      adjustmentPercentage
                    }
                  }
                }
                isSppAvailableOnCheckout: metafield(namespace: $checkoutUpgradeNamespace, key: $checkoutUpgradeKey) {
                  value
                }
                isDefaultSellingPlan: metafield(namespace: $defaultSellingPlanNamespace, key: $defaultSellingPlanKey) {
                  value
                }
                sellingPlanGroupPosition: metafield(namespace: $groupPositionNamespace, key: $groupPositionKey) {
                  value
                }
                shippingLabel: metafield(namespace: $shippingLabelNamespace, key: $shippingLabelKey) {
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

export type EligibleSellingPlan = {
  id: string;
  label: string;
  isDefault: boolean;
  discountLabel: string | null;
  shippingLabel: string | null;
};

type QueryResult = {
  node: {
    sellingPlanAllocations?: {
      edges: {
        node: {
          sellingPlan: {
            id: string;
            billingPolicy: { interval: string; intervalCount: number } | null;
            priceAdjustments: {
              adjustmentValue: { adjustmentPercentage?: number };
            }[];
            isSppAvailableOnCheckout: { value: string } | null;
            isDefaultSellingPlan: { value: string } | null;
            sellingPlanGroupPosition: { value: string } | null;
            shippingLabel: { value: string } | null;
          };
        };
      }[];
    };
  } | null;
};

type StorefrontQuery = <T>(
  query: string,
  options: { variables: Record<string, unknown> },
) => Promise<{ data?: T; errors?: { message: string }[] }>;

function formatFrequency(interval: string, intervalCount: number): string {
  const unit = interval.toLowerCase();
  if (intervalCount <= 1) {
    return `Every ${unit}`;
  }
  return `Every ${intervalCount} ${unit}s`;
}

function formatDiscount(
  priceAdjustments: { adjustmentValue: { adjustmentPercentage?: number } }[],
): string | null {
  const percentageAdjustment = priceAdjustments.find(
    (adjustment) => typeof adjustment.adjustmentValue.adjustmentPercentage === "number",
  );
  if (!percentageAdjustment) {
    return null;
  }
  return `${percentageAdjustment.adjustmentValue.adjustmentPercentage}% off`;
}

// Implements steps 1 & 2 of Loop's upgrade-to-subscription-block guide: fetch a variant's
// selling plans via the Storefront API, then filter to checkout-eligible plans, sort by
// Loop's configured display order, and flag the merchant's chosen default plan.
export async function fetchEligibleSellingPlans(
  query: StorefrontQuery,
  variantId: string,
): Promise<EligibleSellingPlan[]> {
  const { data, errors } = await query<QueryResult>(ELIGIBLE_SELLING_PLANS_QUERY, {
    variables: {
      id: variantId,
      checkoutUpgradeNamespace: CHECKOUT_UPGRADE_METAFIELD.namespace,
      checkoutUpgradeKey: CHECKOUT_UPGRADE_METAFIELD.key,
      defaultSellingPlanNamespace: DEFAULT_SELLING_PLAN_METAFIELD.namespace,
      defaultSellingPlanKey: DEFAULT_SELLING_PLAN_METAFIELD.key,
      groupPositionNamespace: SELLING_PLAN_GROUP_POSITION_METAFIELD.namespace,
      groupPositionKey: SELLING_PLAN_GROUP_POSITION_METAFIELD.key,
      shippingLabelNamespace: SHIPPING_LABEL_METAFIELD.namespace,
      shippingLabelKey: SHIPPING_LABEL_METAFIELD.key,
    },
  });

  if (errors?.length || !data) {
    throw new Error(errors?.[0]?.message ?? "Unknown error fetching selling plans");
  }

  const edges = data.node?.sellingPlanAllocations?.edges ?? [];

  return edges
    .map(({ node }) => node.sellingPlan)
    .filter((plan) => plan.isSppAvailableOnCheckout?.value === "true")
    .sort((a, b) => {
      const positionA = Number(a.sellingPlanGroupPosition?.value ?? 0);
      const positionB = Number(b.sellingPlanGroupPosition?.value ?? 0);
      return positionA - positionB;
    })
    .map((plan): EligibleSellingPlan => {
      // Per Loop support: this metafield holds the *id* of the default selling plan
      // (not a per-plan boolean) — Loop's admin displays it as the bare numeric id
      // (e.g. "8023310379"), while `plan.id` is the full GID, so compare both forms.
      const defaultPlanIdValue = plan.isDefaultSellingPlan?.value;
      const numericId = plan.id.split("/").pop();
      return {
        id: plan.id,
        label: plan.billingPolicy
          ? formatFrequency(plan.billingPolicy.interval, plan.billingPolicy.intervalCount)
          : plan.id,
        isDefault: defaultPlanIdValue === plan.id || defaultPlanIdValue === numericId,
        discountLabel: formatDiscount(plan.priceAdjustments ?? []),
        shippingLabel: plan.shippingLabel?.value || null,
      };
    });
}
