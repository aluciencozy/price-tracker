export type SteamGame = {
  appId: number;
  name: string;
  imageUrl: string;
  // Sample prices use dollars; saved targets use integer cents.
  originalPrice: number;
  // null means the Steam price is missing, while 0 means free.
  currentPrice: number | null;
  discountPercent: number;
  currency: string;
  steamOffer?: {
    steamAppId: number;
    storeId: string;
    currency: string;
    dealId: string;
    observedAt: string;
  };
};
