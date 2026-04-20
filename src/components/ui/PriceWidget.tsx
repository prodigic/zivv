import React from "react";

interface PriceWidgetProps {
  isFree?: boolean;
  priceMin?: number | null;
  priceMax?: number | null;
  className?: string;
}

// Returns tier: 0=free, 1=$(<15), 2=$$(<30), 3=$$$(<75), 4=$$$$
function priceTier(price: number): number {
  if (price < 15) return 1;
  if (price < 30) return 2;
  if (price < 75) return 3;
  return 4;
}

const PriceWidget: React.FC<PriceWidgetProps> = ({
  isFree,
  priceMin,
  priceMax,
  className = "",
}) => {
  const hasPrice = priceMin != null || priceMax != null;
  const price = priceMin ?? priceMax ?? 0;
  const tier = isFree ? 0 : hasPrice && price === 0 ? 0 : hasPrice ? priceTier(price) : null;
  const maxSigns = 4;

  if (tier === null) return null;

  if (tier === 0) {
    return (
      <span
        className={`inline-flex items-center font-semibold text-green-600 dark:text-green-400 ${className}`}
        title="Free"
      >
        FREE
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center font-semibold tabular-nums ${className}`}
      title={priceMin != null ? `$${Math.ceil(priceMin)}${priceMax && priceMax !== priceMin ? `–$${Math.ceil(priceMax)}` : ""}` : ""}
    >
      {Array.from({ length: maxSigns }).map((_, i) => (
        <span
          key={i}
          className={
            i < tier
              ? "text-green-600 dark:text-green-400"
              : "text-gray-300 dark:text-gray-600"
          }
        >
          $
        </span>
      ))}
    </span>
  );
};

export default PriceWidget;
